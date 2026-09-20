//! Native sherpa-onnx VITS voice adapter.

use std::ffi::CString;
use std::path::Path;

use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig,
    OfflineTtsVitsModelConfig,
};

pub struct VitsConfig {
    pub model: String,
    pub tokens: String,
    pub lexicon: String,
    pub rule_fsts: String,
    pub num_threads: i32,
    pub max_num_sentences: i32,
    pub silence_scale: f32,
}

pub struct Clip {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

pub struct Vits {
    tts: OfflineTts,
    silence_scale: f32,
}

impl Vits {
    pub fn load(config: &VitsConfig) -> Result<Self, String> {
        for path in [&config.model, &config.tokens, &config.lexicon] {
            if !Path::new(path).exists() {
                return Err(format!("the voice is missing {path}"));
            }
        }

        let tts = OfflineTts::create(&OfflineTtsConfig {
            model: OfflineTtsModelConfig {
                vits: OfflineTtsVitsModelConfig {
                    model: Some(config.model.clone()),
                    tokens: Some(config.tokens.clone()),
                    lexicon: Some(config.lexicon.clone()),
                    noise_scale: 0.667,
                    noise_scale_w: 0.8,
                    length_scale: 1.0,
                    ..Default::default()
                },
                num_threads: config.num_threads.max(1),
                debug: false,
                provider: Some("cpu".to_owned()),
                ..Default::default()
            },
            rule_fsts: Some(config.rule_fsts.clone()),
            max_num_sentences: config.max_num_sentences,
            silence_scale: config.silence_scale,
            ..Default::default()
        })
        .ok_or_else(|| "sherpa-onnx refused the VITS voice configuration".to_owned())?;

        Ok(Self {
            tts,
            silence_scale: config.silence_scale,
        })
    }

    pub fn generate(&mut self, text: &str, sid: i32, speed: f32) -> Result<Clip, String> {
        CString::new(text).map_err(|_| "the text contains a NUL byte".to_owned())?;
        let audio = self
            .tts
            .generate_with_config(
                text,
                &GenerationConfig {
                    sid,
                    speed,
                    silence_scale: self.silence_scale,
                    ..Default::default()
                },
                None::<fn(&[f32], f32) -> bool>,
            )
            .ok_or_else(|| "the voice produced nothing".to_owned())?;

        Ok(Clip {
            samples: audio.samples().to_vec(),
            sample_rate: audio.sample_rate().max(1) as u32,
        })
    }
}
