//! The OCR model sets, pinned: the same Hugging Face files and revisions as
//! `src/lib/ocr/models.ts`, by the same set ids, with their sizes and hashes.
//! The two Chinese dictionaries are one file (identical bytes), so it is one pin.

use sapling_models::ModelFile;

pub const MOBILE_DET: ModelFile = ModelFile {
    name: "ppocrv5-mobile-det.onnx",
    url: "https://huggingface.co/webnn/PP-OCRv5-ONNX/resolve/006b4419a415072fbb16a1d7d0d8548f789a8fae/ch_PP-OCRv5_det.onnx",
    bytes: 4_748_769,
    sha256: "d7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924",
};
pub const SERVER_DET: ModelFile = ModelFile {
    name: "ppocrv5-server-det.onnx",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/detection/v5/det.onnx",
    bytes: 88_030_804,
    sha256: "61824840edf6e74581898930b8091b1b2318f4b2705a2e8a40ad3de7ac480133",
};
pub const ZH_MOBILE_REC: ModelFile = ModelFile {
    name: "ppocrv5-zh-mobile-rec.onnx",
    url: "https://huggingface.co/webnn/PP-OCRv5-ONNX/resolve/006b4419a415072fbb16a1d7d0d8548f789a8fae/ch_PP-OCRv5_rec.onnx",
    bytes: 16_517_247,
    sha256: "bf66820f48fa99f779974c4df78e5274a9d8e0458c4137e8c5357e40e2c3faf2",
};
pub const ZH_SERVER_REC: ModelFile = ModelFile {
    name: "ppocrv5-zh-server-rec.onnx",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/chinese/rec.onnx",
    bytes: 84_468_836,
    sha256: "26fa4f47060f58e25962b9af6beaee05c8182b90e026c4ecc6db165d9dfdc38a",
};
pub const ZH_DICT: ModelFile = ModelFile {
    name: "ppocrv5-zh-dict.txt",
    url: "https://huggingface.co/webnn/PP-OCRv5-ONNX/resolve/006b4419a415072fbb16a1d7d0d8548f789a8fae/ch_PP-OCRv5_dict.txt",
    bytes: 74_012,
    sha256: "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b",
};
pub const LATIN_REC: ModelFile = ModelFile {
    name: "ppocrv5-latin-rec.onnx",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/latin/rec.onnx",
    bytes: 7_862_832,
    sha256: "614ffc2d6d3902d360fad7f1b0dd455ee45e877069d14c4e51a99dc4ef144409",
};
pub const LATIN_DICT: ModelFile = ModelFile {
    name: "ppocrv5-latin-dict.txt",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/latin/dict.txt",
    bytes: 1_634,
    sha256: "3c0a8a79b612653c25f765271714f71281e4e955962c153e272b7b8c1d2b13ff",
};
pub const KOREAN_REC: ModelFile = ModelFile {
    name: "ppocrv5-korean-rec.onnx",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/korean/rec.onnx",
    bytes: 13_401_252,
    sha256: "322f140154c820fcb83c3d24cfe42c9ec70dd1a1834163306a7338136e4f1eaa",
};
pub const KOREAN_DICT: ModelFile = ModelFile {
    name: "ppocrv5-korean-dict.txt",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/korean/dict.txt",
    bytes: 47_451,
    sha256: "a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7",
};

pub struct ModelSet {
    pub id: &'static str,
    pub det: &'static ModelFile,
    pub rec: &'static ModelFile,
    pub dict: &'static ModelFile,
}

pub const SETS: &[ModelSet] = &[
    ModelSet {
        id: "zh-mobile",
        det: &MOBILE_DET,
        rec: &ZH_MOBILE_REC,
        dict: &ZH_DICT,
    },
    ModelSet {
        id: "zh-server",
        det: &SERVER_DET,
        rec: &ZH_SERVER_REC,
        dict: &ZH_DICT,
    },
    ModelSet {
        id: "latin-mobile",
        det: &MOBILE_DET,
        rec: &LATIN_REC,
        dict: &LATIN_DICT,
    },
    ModelSet {
        id: "latin-server",
        det: &SERVER_DET,
        rec: &LATIN_REC,
        dict: &LATIN_DICT,
    },
    ModelSet {
        id: "ko-mobile",
        det: &MOBILE_DET,
        rec: &KOREAN_REC,
        dict: &KOREAN_DICT,
    },
];

pub fn set(id: &str) -> Option<&'static ModelSet> {
    SETS.iter().find(|set| set.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEBNN: &str =
        "https://huggingface.co/webnn/PP-OCRv5-ONNX/resolve/006b4419a415072fbb16a1d7d0d8548f789a8fae";
    const MONKT: &str =
        "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65";

    /// Every set id and file path here is the browser's too, at the same revisions.
    #[test]
    fn the_sets_match_the_browsers() {
        let ts = include_str!("../../../src/lib/ocr/models.ts");
        assert!(ts.contains(WEBNN) && ts.contains(MONKT));
        for set in SETS {
            assert!(ts.contains(&format!("id: '{}'", set.id)), "{}", set.id);
            for file in [set.det, set.rec, set.dict] {
                let path = file
                    .url
                    .strip_prefix(WEBNN)
                    .map(|path| format!("${{WEBNN}}{path}"))
                    .or_else(|| {
                        file.url
                            .strip_prefix(MONKT)
                            .map(|path| format!("${{MONKT}}{path}"))
                    })
                    .expect("a pinned base");
                assert!(ts.contains(&path), "{} {}", set.id, path);
            }
        }
    }

    #[test]
    fn file_names_are_unique_per_pin() {
        let files = [
            &MOBILE_DET,
            &SERVER_DET,
            &ZH_MOBILE_REC,
            &ZH_SERVER_REC,
            &ZH_DICT,
            &LATIN_REC,
            &LATIN_DICT,
            &KOREAN_REC,
            &KOREAN_DICT,
        ];
        for a in files {
            assert_eq!(a.sha256.len(), 64);
            for b in files {
                assert_eq!(a.name == b.name, a.url == b.url, "{} {}", a.name, b.name);
            }
        }
    }
}
