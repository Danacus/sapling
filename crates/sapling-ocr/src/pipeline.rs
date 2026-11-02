//! PP-OCR's pre- and post-processing, pure: an RGBA raster in, lines with the x
//! of every character boundary out, the models run between these steps.
//! `src/lib/ocr/pipeline.ts` is the same code for the browser; the constants
//! and output shape must stay identical.

use serde::Serialize;

pub struct Raster<'a> {
    /// RGBA, row-major, as `ImageData.data`.
    pub data: &'a [u8],
    pub width: usize,
    pub height: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Box {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OcrLine {
    pub text: String,
    /// In the raster's pixels.
    #[serde(rename = "box")]
    pub bbox: Box,
    /// `text`'s UTF-16 length + 1 x coordinates; a surrogate pair's two units
    /// share a span.
    pub edges: Vec<f64>,
    /// Mean confidence of the emitted characters, 0–1.
    pub score: f64,
}

pub struct Tensor {
    pub data: Vec<f32>,
    pub dims: [usize; 4],
}

/// PaddleOCR's det normalisation (ImageNet), on BGR as its cv2 reader gives.
const DET_MEAN: [f64; 3] = [0.406, 0.456, 0.485];
const DET_STD: [f64; 3] = [0.225, 0.224, 0.229];
/// A pixel is text above this.
const DET_THRESH: f32 = 0.3;
/// A region is kept when its mean probability clears this.
const DET_BOX_THRESH: f64 = 0.6;
/// DB trains on regions shrunk by this much; the box grows back by it.
const DET_UNCLIP: f64 = 1.5;
const DET_MIN_SIDE: usize = 3;
pub const DET_LIMIT: usize = 1536;

pub const REC_HEIGHT: usize = 48;
/// Short crops are padded to this, as PaddleOCR's default 320×48 shape is.
const REC_MIN_WIDTH: usize = 160;

/// Bilinear sample of channel `c` at a fractional position, edge-clamped.
fn sample(raster: &Raster, x: f64, y: f64, c: usize) -> f64 {
    let (width, height) = (raster.width, raster.height);
    let x0 = (x.floor().max(0.0) as usize).min(width - 1);
    let y0 = (y.floor().max(0.0) as usize).min(height - 1);
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let fx = (x - x0 as f64).clamp(0.0, 1.0);
    let fy = (y - y0 as f64).clamp(0.0, 1.0);
    let at = |xx: usize, yy: usize| raster.data[(yy * width + xx) * 4 + c] as f64;
    let top = at(x0, y0) * (1.0 - fx) + at(x1, y0) * fx;
    let bottom = at(x0, y1) * (1.0 - fx) + at(x1, y1) * fx;
    top * (1.0 - fy) + bottom * fy
}

pub struct DetInput {
    pub tensor: Tensor,
    /// Detector pixels per raster pixel, per axis.
    pub sx: f64,
    pub sy: f64,
}

/// The page scaled so its long side is at most `limit`, each side a multiple of
/// 32 (the detector's stride), as a `[1, 3, h, w]` BGR tensor.
pub fn det_input(raster: &Raster, limit: usize) -> DetInput {
    let scale = (limit as f64 / raster.width.max(raster.height) as f64).min(1.0);
    let w = 32.max(((raster.width as f64 * scale) / 32.0).round() as usize * 32);
    let h = 32.max(((raster.height as f64 * scale) / 32.0).round() as usize * 32);
    let sx = w as f64 / raster.width as f64;
    let sy = h as f64 / raster.height as f64;
    let plane = w * h;
    let mut data = vec![0f32; 3 * plane];
    for y in 0..h {
        let ry = (y as f64 + 0.5) / sy - 0.5;
        for x in 0..w {
            let rx = (x as f64 + 0.5) / sx - 0.5;
            for c in 0..3 {
                // Tensor channel c is BGR: c=0 reads the raster's blue.
                let v = sample(raster, rx, ry, 2 - c) / 255.0;
                data[c * plane + y * w + x] = ((v - DET_MEAN[c]) / DET_STD[c]) as f32;
            }
        }
    }
    DetInput {
        tensor: Tensor {
            data,
            dims: [1, 3, h, w],
        },
        sx,
        sy,
    }
}

/// Text regions in the detector's `[1, 1, h, w]` probability map, back in
/// raster pixels: 4-connected components over the threshold, each bounding box
/// grown by DB's unclip distance. Sorted top to bottom, then left to right.
pub fn det_boxes(prob: &[f32], h: usize, w: usize, input: &DetInput, raster: &Raster) -> Vec<Box> {
    let mut seen = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    let mut boxes: Vec<Box> = Vec::new();
    for start in 0..w * h {
        if seen[start] || prob[start] <= DET_THRESH {
            continue;
        }
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (w, h, 0, 0);
        let mut sum = 0f64;
        let mut count = 0usize;
        seen[start] = true;
        stack.push(start);
        while let Some(i) = stack.pop() {
            let x = i % w;
            let y = i / w;
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
            sum += prob[i] as f64;
            count += 1;
            let next = [
                (x > 0).then(|| i - 1),
                (x < w - 1).then(|| i + 1),
                (y > 0).then(|| i - w),
                (y < h - 1).then(|| i + w),
            ];
            for j in next.into_iter().flatten() {
                if !seen[j] && prob[j] > DET_THRESH {
                    seen[j] = true;
                    stack.push(j);
                }
            }
        }
        let bw = max_x - min_x + 1;
        let bh = max_y - min_y + 1;
        if bw.min(bh) < DET_MIN_SIDE || sum / (count as f64) < DET_BOX_THRESH {
            continue;
        }
        let (bw, bh) = (bw as f64, bh as f64);
        let d = (bw * bh * DET_UNCLIP) / (2.0 * (bw + bh));
        let x0 = ((min_x as f64 - d) / input.sx).max(0.0);
        let y0 = ((min_y as f64 - d) / input.sy).max(0.0);
        let x1 = ((max_x as f64 + 1.0 + d) / input.sx).min(raster.width as f64);
        let y1 = ((max_y as f64 + 1.0 + d) / input.sy).min(raster.height as f64);
        boxes.push(Box {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        });
    }
    // Rows first: two boxes whose vertical centres are within half a line are on
    // the same row and go left to right. The rule is not transitive, which
    // `sort_by` may panic on, so this is an insertion sort over it.
    let before = |a: &Box, b: &Box| {
        let dy = a.y + a.h / 2.0 - (b.y + b.h / 2.0);
        if dy.abs() < a.h.min(b.h) / 2.0 {
            a.x < b.x
        } else {
            dy < 0.0
        }
    };
    for i in 1..boxes.len() {
        let mut j = i;
        while j > 0 && before(&boxes[j], &boxes[j - 1]) {
            boxes.swap(j, j - 1);
            j -= 1;
        }
    }
    boxes
}

/// One box cut out at `REC_HEIGHT`, aspect kept, right-padded with zeros.
pub fn rec_input(raster: &Raster, bbox: &Box) -> Tensor {
    let scale = REC_HEIGHT as f64 / bbox.h;
    let content_width = 1.max((bbox.w * scale).round() as usize);
    let w = REC_MIN_WIDTH.max(content_width.div_ceil(8) * 8);
    let plane = REC_HEIGHT * w;
    let mut data = vec![0f32; 3 * plane];
    for y in 0..REC_HEIGHT {
        let ry = bbox.y + (y as f64 + 0.5) / scale - 0.5;
        for x in 0..content_width {
            let rx = bbox.x + (x as f64 + 0.5) / scale - 0.5;
            for c in 0..3 {
                let v = sample(raster, rx, ry, 2 - c) / 255.0;
                data[c * plane + y * w + x] = ((v - 0.5) / 0.5) as f32;
            }
        }
    }
    Tensor {
        data,
        dims: [1, 3, REC_HEIGHT, w],
    }
}

/// Greedy CTC over `[1, steps, classes]` logits from a crop `input_width`
/// wide: class 0 is the blank, `1..=dict.len()` the dictionary, the last a
/// space. Each character's x is the centre of the timesteps that emitted it,
/// mapped back through the crop; a boundary is the midpoint between two
/// centres, the line's ends the box's.
pub fn rec_decode(
    logits: &[f32],
    steps: usize,
    classes: usize,
    input_width: usize,
    bbox: Box,
    dict: &[String],
) -> OcrLine {
    struct Char<'d> {
        text: &'d str,
        centre: f64,
        prob: f64,
    }
    let step_width = input_width as f64 / steps as f64;
    let scale = bbox.h / REC_HEIGHT as f64;
    let mut chars: Vec<Char> = Vec::new();
    let mut prev = 0usize;
    let mut run_start = 0usize;
    for t in 0..=steps {
        let mut best = 0usize;
        let mut best_p = f32::NEG_INFINITY;
        if t < steps {
            let row = &logits[t * classes..(t + 1) * classes];
            for (k, &p) in row.iter().enumerate() {
                if p > best_p {
                    best_p = p;
                    best = k;
                }
            }
        }
        if t < steps && best == prev {
            continue;
        }
        // The run of `prev` that ended at t is one character.
        if prev != 0 && t > 0 {
            let centre = ((run_start + t) as f64 / 2.0) * step_width;
            let last = chars.last_mut().expect("a run has a character");
            last.centre = bbox.x + centre * scale;
            last.text = if prev <= dict.len() {
                &dict[prev - 1]
            } else {
                " "
            };
        }
        if t < steps && best != 0 {
            chars.push(Char {
                text: "",
                centre: 0.0,
                prob: best_p as f64,
            });
        }
        prev = best;
        run_start = t;
    }
    let mut text = String::new();
    let mut edges = vec![bbox.x];
    for (i, char) in chars.iter().enumerate() {
        let right = match chars.get(i + 1) {
            Some(next) => (char.centre + next.centre) / 2.0,
            None => bbox.x + bbox.w,
        };
        text.push_str(char.text);
        // Every UTF-16 unit of the character ends at the same boundary.
        edges.extend(std::iter::repeat_n(right, char.text.encode_utf16().count()));
    }
    let score = if chars.is_empty() {
        0.0
    } else {
        chars.iter().map(|c| c.prob).sum::<f64>() / chars.len() as f64
    };
    OcrLine {
        text,
        bbox,
        edges,
        score,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank(width: usize, height: usize) -> Vec<u8> {
        vec![255; width * height * 4]
    }

    /// `[1, T, C]` logits with class `path[t]` winning at each step.
    fn logits(path: &[usize], classes: usize) -> Vec<f32> {
        let mut data = vec![0f32; path.len() * classes];
        for (t, &k) in path.iter().enumerate() {
            data[t * classes + k] = 0.9;
        }
        data
    }

    fn dict() -> Vec<String> {
        ["你", "好", "吗"].map(String::from).to_vec()
    }
    const CLASSES: usize = 5; // blank, the dictionary, a space

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn collapses_repeats_drops_blanks_and_reads_the_last_class_as_a_space() {
        let path = [0, 1, 1, 0, 2, 0, 4, 3, 3, 0];
        let bbox = Box {
            x: 0.0,
            y: 0.0,
            w: 80.0,
            h: REC_HEIGHT as f64,
        };
        let line = rec_decode(&logits(&path, CLASSES), 10, CLASSES, 80, bbox, &dict());
        assert_eq!(line.text, "你好 吗");
        assert!((line.score - 0.9).abs() < 1e-6);
    }

    #[test]
    fn places_each_character_at_the_centre_of_the_steps_that_emitted_it() {
        // 10 steps over an 80px crop at scale 1: 8px a step, the box at x=100.
        let path = [1, 1, 0, 0, 0, 0, 0, 0, 2, 2];
        let bbox = Box {
            x: 100.0,
            y: 0.0,
            w: 80.0,
            h: REC_HEIGHT as f64,
        };
        let line = rec_decode(&logits(&path, CLASSES), 10, CLASSES, 80, bbox, &dict());
        assert_eq!(line.text, "你好");
        assert_eq!(line.edges, vec![100.0, 140.0, 180.0]);
    }

    #[test]
    fn maps_positions_back_through_the_crop_scale() {
        let path = [1, 0, 0, 2];
        // A box twice the crop's height: every crop pixel is two page pixels.
        let bbox = Box {
            x: 0.0,
            y: 0.0,
            w: 64.0,
            h: REC_HEIGHT as f64 * 2.0,
        };
        let line = rec_decode(&logits(&path, CLASSES), 4, CLASSES, 32, bbox, &dict());
        assert_eq!(line.edges, vec![0.0, 32.0, 64.0]);
    }

    #[test]
    fn a_surrogate_pair_takes_two_edges_at_one_boundary() {
        let dict = vec!["𠮷".to_owned()];
        let bbox = Box {
            x: 0.0,
            y: 0.0,
            w: 16.0,
            h: REC_HEIGHT as f64,
        };
        let line = rec_decode(&logits(&[1, 1], 3), 2, 3, 16, bbox, &dict);
        assert_eq!(line.edges, vec![0.0, 16.0, 16.0]);
    }

    #[test]
    fn finds_each_region_over_the_threshold_and_grows_it_back_by_the_unclip_distance() {
        let data = blank(64, 32);
        let raster = Raster {
            data: &data,
            width: 64,
            height: 32,
        };
        let input = det_input(&raster, DET_LIMIT);
        let [_, _, h, w] = input.tensor.dims;
        let mut map = vec![0f32; w * h];
        // One 20×4 region at (10, 10), and a lone faint pixel that must be dropped.
        for y in 10..14 {
            for x in 10..30 {
                map[y * w + x] = 0.9;
            }
        }
        map[2 * w + 50] = 0.4;
        let boxes = det_boxes(&map, h, w, &input, &raster);
        assert_eq!(boxes.len(), 1);
        let d = (20.0 * 4.0 * 1.5) / (2.0 * 24.0);
        assert!(close(boxes[0].x, 10.0 - d));
        assert!(close(boxes[0].w, 20.0 + 2.0 * d));
    }

    #[test]
    fn orders_a_row_left_to_right_before_the_next_row() {
        let data = blank(64, 64);
        let raster = Raster {
            data: &data,
            width: 64,
            height: 64,
        };
        let input = det_input(&raster, DET_LIMIT);
        let [_, _, h, w] = input.tensor.dims;
        let mut map = vec![0f32; w * h];
        let mut fill = |x0: usize, y0: usize| {
            for y in y0..y0 + 6 {
                for x in x0..x0 + 10 {
                    map[y * w + x] = 0.9;
                }
            }
        };
        fill(40, 41); // second row
        fill(40, 11); // first row, right
        fill(5, 12); // first row, left, a pixel lower
        let boxes = det_boxes(&map, h, w, &input, &raster);
        let centres: Vec<i64> = boxes
            .iter()
            .map(|b| (b.x + b.w / 2.0).round() as i64)
            .collect();
        assert_eq!(centres, vec![10, 45, 45]);
        assert!(boxes[2].y > boxes[1].y);
    }

    #[test]
    fn the_detector_input_is_a_multiple_of_32_normalised_as_bgr() {
        // A pure red page: the tensor's last channel is red.
        let data: Vec<u8> = (0..100 * 50).flat_map(|_| [255, 0, 0, 255]).collect();
        let raster = Raster {
            data: &data,
            width: 100,
            height: 50,
        };
        let input = det_input(&raster, DET_LIMIT);
        assert_eq!(input.tensor.dims, [1, 3, 64, 96]);
        let plane = 64 * 96;
        assert!(close(input.tensor.data[0] as f64, (0.0 - 0.406) / 0.225));
        assert!(close(
            input.tensor.data[2 * plane] as f64,
            ((1.0 - 0.485) / 0.229) as f32 as f64
        ));
    }

    #[test]
    fn a_recognizer_crop_keeps_its_aspect_and_pads_to_the_minimum_width() {
        let data = blank(200, 100);
        let raster = Raster {
            data: &data,
            width: 200,
            height: 100,
        };
        let short = rec_input(
            &raster,
            &Box {
                x: 0.0,
                y: 0.0,
                w: 50.0,
                h: 24.0,
            },
        );
        assert_eq!(short.dims, [1, 3, REC_HEIGHT, REC_MIN_WIDTH]);
        // 50 wide at ×2 is 100 px of white, then zero padding.
        assert_eq!(short.data[99], 1.0);
        assert_eq!(short.data[100], 0.0);
        let long = rec_input(
            &raster,
            &Box {
                x: 0.0,
                y: 0.0,
                w: 190.0,
                h: 48.0,
            },
        );
        assert_eq!(long.dims, [1, 3, REC_HEIGHT, 192]);
        assert_eq!(long.data[189], 1.0);
        assert_eq!(long.data[190], 0.0);
    }
}
