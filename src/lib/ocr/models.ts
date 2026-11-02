/**
 * The OCR model sets: a detector shared by every script and a recognizer plus
 * dictionary per script, PP-OCRv5, ONNX, pinned by Hugging Face revision.
 *
 * Two sizes. *Mobile* (5 MB + 16 MB) is ~9× faster in wasm and reads printed
 * textbook lines nearly as well; *server* (88 MB + 84 MB) reads more and is the
 * native host's natural pick. Measured on one HSK 1 page (1394×1837, 71 lines),
 * wasm, 4 threads in node: mobile 0.8 s det + 1.8 s rec, server 11.5 s + 12.5 s.
 */

const WEBNN =
	'https://huggingface.co/webnn/PP-OCRv5-ONNX/resolve/006b4419a415072fbb16a1d7d0d8548f789a8fae';
const MONKT =
	'https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65';

export interface ModelSet {
	id: string;
	label: string;
	det: string;
	rec: string;
	dict: string;
}

export type OcrScript = 'chinese' | 'latin' | 'korean';
export type OcrSize = 'mobile' | 'server';

const SETS: Record<OcrScript, Partial<Record<OcrSize, ModelSet>>> = {
	chinese: {
		mobile: {
			id: 'zh-mobile',
			label: 'Chinese · mobile',
			det: `${WEBNN}/ch_PP-OCRv5_det.onnx`,
			rec: `${WEBNN}/ch_PP-OCRv5_rec.onnx`,
			dict: `${WEBNN}/ch_PP-OCRv5_dict.txt`
		},
		server: {
			id: 'zh-server',
			label: 'Chinese · server',
			det: `${MONKT}/detection/v5/det.onnx`,
			rec: `${MONKT}/languages/chinese/rec.onnx`,
			dict: `${MONKT}/languages/chinese/dict.txt`
		}
	},
	// monkt's Latin and Korean recognizers are the mobile ones; the detector is
	// shared, so each script pairs its recognizer with either.
	latin: {
		mobile: {
			id: 'latin-mobile',
			label: 'Latin · mobile',
			det: `${WEBNN}/ch_PP-OCRv5_det.onnx`,
			rec: `${MONKT}/languages/latin/rec.onnx`,
			dict: `${MONKT}/languages/latin/dict.txt`
		},
		server: {
			id: 'latin-server',
			label: 'Latin · server det',
			det: `${MONKT}/detection/v5/det.onnx`,
			rec: `${MONKT}/languages/latin/rec.onnx`,
			dict: `${MONKT}/languages/latin/dict.txt`
		}
	},
	korean: {
		mobile: {
			id: 'ko-mobile',
			label: 'Korean · mobile',
			det: `${WEBNN}/ch_PP-OCRv5_det.onnx`,
			rec: `${MONKT}/languages/korean/rec.onnx`,
			dict: `${MONKT}/languages/korean/dict.txt`
		}
	}
};

/** The recognizer for a BCP-47 tag: CJK through the Chinese one (it reads kana too). */
export function scriptFor(tag: string | undefined): OcrScript {
	const lang = (tag ?? '').toLowerCase().split('-')[0];
	if (lang === 'ko') return 'korean';
	if (['zh', 'yue', 'ja', 'cmn'].includes(lang)) return 'chinese';
	return 'latin';
}

export function modelSet(script: OcrScript, size: OcrSize): ModelSet {
	return SETS[script][size] ?? SETS[script].mobile!;
}

export function sizesFor(script: OcrScript): OcrSize[] {
	return Object.keys(SETS[script]) as OcrSize[];
}
