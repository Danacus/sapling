//! Reads one page natively and prints the timings and lines, by hand:
//! `cargo run --release -p sapling-ocr --example page -- page.ppm zh-server`.
//! The page is a binary PPM (`pdftoppm -r 150 -f 32 -l 32 book.pdf page`);
//! models install into `$SAPLING_APP_DATA/ocr`, else `./ocr-models/ocr`.

use std::path::PathBuf;

use sapling_ocr::{OcrHandle, Raster};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a .ppm page");
    let set = args.next().unwrap_or_else(|| "zh-mobile".to_owned());
    let bytes = std::fs::read(&path).expect("the page");
    let (width, height, rgb) = ppm(&bytes);
    let rgba: Vec<u8> = rgb
        .chunks_exact(3)
        .flat_map(|p| [p[0], p[1], p[2], 255])
        .collect();
    let raster = Raster {
        data: &rgba,
        width,
        height,
    };
    let dir = std::env::var_os("SAPLING_APP_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("ocr-models"));
    let handle = OcrHandle::new(&dir);
    for run in ["cold", "warm"] {
        let result = handle.read_page(&raster, &set, &|_, _, _| {}).unwrap();
        println!(
            "{run}: {} lines, load {:.0} ms, page {:.0} ms ({})",
            result.lines.len(),
            result.timings.load_ms,
            result.timings.page_ms,
            result.backend
        );
        if run == "warm" {
            for line in &result.lines {
                println!("{:.2} {}", line.score, line.text);
            }
        }
    }
}

/// `P6 <w> <h> 255\n` then RGB bytes.
fn ppm(bytes: &[u8]) -> (usize, usize, &[u8]) {
    let mut fields = Vec::new();
    let mut at = 0;
    while fields.len() < 4 {
        while bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        let start = at;
        while !bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        fields.push(std::str::from_utf8(&bytes[start..at]).unwrap().to_owned());
    }
    assert_eq!(fields[0], "P6", "a binary PPM");
    let width = fields[1].parse().unwrap();
    let height = fields[2].parse().unwrap();
    (width, height, &bytes[at + 1..])
}
