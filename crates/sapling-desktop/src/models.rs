//! Where a native speech model comes from, how it gets here, and how much CPU
//! it gets once it is here.
//!
//! Two capabilities now run ONNX on this host — the Kokoro voice (`tts`) and
//! the SenseVoice recognizer (`asr`) — and everything they share about a *model
//! on disk* lives here rather than being copied: one [`ModelSpec`] per model
//! pinning URL, exact byte size and sha256, one download-verify-unpack-rename
//! install, one "is it here and what does it cost" probe. The two engines keep
//! their own configuration and their own opinions; neither knows about the
//! other, and both call this.
//!
//! The browser fetches Kokoro as an Emscripten *file package* — one 427 MB blob
//! whose byte offsets are baked into vendored glue, which is why
//! `src/lib/tts/models.ts` pins a third-party mirror commit. Native sherpa-onnx
//! reads ordinary files, so this host takes every model straight from k2-fsa's
//! own release assets instead: no mirror in the trust path.
//!
//! Both numbers beside a URL are checked before anything is extracted, because
//! a truncated `model.onnx` does not fail at load — it fails somewhere inside
//! ONNX with a message about a tensor.
//!
//! ## An install is staged, and one rename publishes it
//!
//! [`ModelSpec::unpack`] extracts into a `.partial` directory beside the model
//! and [`ModelSpec::commit_staged`] moves it into place with a single
//! `fs::rename`. That is not tidiness. A learner who opens a lesson while the
//! download is unpacking makes the session screen call `warmSpeech`, which
//! loads the engine over whatever is on disk — and sherpa-onnx handed a
//! half-written `espeak-ng-data` does not return an error: espeak's own init
//! calls `exit(-1)` and takes the process with it. A rename inside one
//! directory is atomic, so the live path is only ever *absent* or a *whole*
//! model, and no reader has to hold a lock to be safe from a writer. A crash
//! or a cancel leaves the staging tree behind instead, which the next install
//! removes before it starts.
//!
//! ## The thread count is here because it is the same question twice
//!
//! Both engines are one interactive ONNX request at a time on whatever machine
//! this is, so both want the same answer — see [`available_threads`].

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// One pinned model archive, and what it must unpack to.
pub struct ModelSpec {
    /// The directory the archive contains, and therefore the one it creates.
    /// It is also the model's name everywhere else: the progress keys are built
    /// from it, and it is what `status` reports to the window.
    pub dir: &'static str,
    /// Download URL, pinned to an immutable release asset.
    pub url: &'static str,
    /// Exact size of the archive. A mismatch is a truncated or wrong download.
    pub bytes: u64,
    /// Sha256 of the archive, lowercase hex.
    pub sha256: &'static str,
    /// Files that must exist under `dir` for the model to be usable. Not the
    /// whole archive — the ones the engine config actually names. The staging
    /// rename is what keeps a partial tree off the live path; this list is the
    /// cheap sanity check either side of it, and the only thing that would
    /// catch a tree an *older* build left half-extracted where the model goes.
    pub files: &'static [&'static str],
}

/// Kokoro multi-lang v1.1, fp32 — 103 speakers, Mandarin + English.
///
/// **fp32, and not int8, deliberately.** The release also ships
/// `kokoro-int8-multi-lang-v1_1.tar.bz2` at 147 MB against this one's 365 MB,
/// and the temptation is obvious. See the note in `tts/mod.rs` for what was
/// measured: the int8 bug is the *WASM* build's, and one model on both hosts is
/// still worth more than the megabytes.
///
/// The size and hash are of the release asset as published; they are not
/// derived from anything and must be re-measured if the pin ever moves.
pub const KOKORO: ModelSpec = ModelSpec {
    dir: "kokoro-multi-lang-v1_1",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2",
    bytes: 364_816_464,
    sha256: "a3f4c73d043860e3fd2e5b06f36795eb81de0fc8e8de6df703245edddd87dbad",
    files: &[
        "model.onnx",
        "voices.bin",
        "tokens.txt",
        "lexicon-us-en.txt",
        "lexicon-zh.txt",
        "date-zh.fst",
        "number-zh.fst",
        "espeak-ng-data/phontab",
        "dict/jieba.dict.utf8",
    ],
};

/// SenseVoice small, int8 — the recognizer, covering zh, en, ja, ko and yue.
///
/// **int8 here, and that is not a contradiction of [`KOKORO`].** The reason
/// Kokoro ships fp32 is that one model must sound the same on both hosts, and
/// the browser's fp32 is the one that works; there is no browser recognizer at
/// all, so nothing has to agree with anything. What is left is the trade on its
/// own terms, and int8 wins it: 239 MB of weights against 938 MB, indexed
/// against a quality difference nobody has been able to hear in a dictated
/// sentence, on a phone that has to hold the voice model too.
///
/// **The archive is the int8-only one**, not the combined release asset. Both
/// unpack the same `model.int8.onnx`, but the combined archive is 1,047,870,769
/// bytes because it also carries the fp32 export — a gigabyte downloaded to
/// keep a sixth of it. This one is 163 MB and contains exactly what is used.
///
/// It also ships `test_wavs/`, one sentence per language, which is what
/// `tests/dictation.rs` transcribes.
pub const SENSE_VOICE: ModelSpec = ModelSpec {
    dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
    bytes: 163_002_883,
    sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
    files: &["model.int8.onnx", "tokens.txt"],
};

/// How often the download reports. Every chunk would be thousands of events
/// across an IPC boundary for a bar that is 400 pixels wide.
const PROGRESS_STEP_BYTES: u64 = 4 * 1024 * 1024;

/// Threads to give ONNX on a phone, whatever [`std::thread::available_parallelism`]
/// says.
///
/// A desktop gets every core, because this is one interactive request at a time
/// and nothing else is competing for the box. A phone's cores are not
/// interchangeable: a big.LITTLE eight is four fast and four slow, and an ONNX
/// session split evenly across them runs at the pace of the slow ones while
/// spending the battery of all eight. Four is the usual size of the fast
/// cluster and is the number to revisit if anyone ever measures this on a
/// device — nobody here has.
const MOBILE_MAX_THREADS: usize = 4;

/// What the UI is told while an install runs: a step name, bytes so far, bytes
/// expected. Deliberately the same three fields `sherpa.ts` emits, so the
/// browser's progress listener takes these unchanged.
pub type OnProgress<'a> = &'a (dyn Fn(&str, u64, u64) + Send + Sync);

/// Cores to give ONNX, never fewer than one and never more than a phone should
/// spend (see [`MOBILE_MAX_THREADS`]).
pub fn available_threads() -> i32 {
    let ceiling = if cfg!(desktop) {
        usize::MAX
    } else {
        MOBILE_MAX_THREADS
    };
    std::thread::available_parallelism()
        .map(|cores| cores.get().min(ceiling).min(i32::MAX as usize) as i32)
        .unwrap_or(1)
}

impl ModelSpec {
    /// Where this model lives under the app's directory for its kind
    /// (`<app-data>/tts`, `<app-data>/asr`).
    pub fn dir_in(&self, models_dir: &Path) -> PathBuf {
        models_dir.join(self.dir)
    }

    /// Where an install assembles the model before it is published.
    ///
    /// A sibling of [`dir_in`](Self::dir_in), so the two are on one filesystem
    /// and the move between them is a rename rather than a copy. One fixed
    /// name, not one per run: the only thing that may be assembling a model is
    /// the install holding that handle's `installing` lock, and a fixed name is
    /// what makes a crashed run's leftovers findable by the next one.
    pub fn staging_in(&self, models_dir: &Path) -> PathBuf {
        models_dir.join(format!("{}.partial", self.dir))
    }

    /// Whether every file the engine config names is present.
    pub fn installed_in(&self, models_dir: &Path) -> bool {
        let dir = self.dir_in(models_dir);
        self.files.iter().all(|file| dir.join(file).is_file())
    }

    /// Bytes the model occupies on disk right now — 0 when nothing is there.
    ///
    /// This walks the tree rather than summing [`files`](Self::files): what the
    /// Settings row reports is "what is this costing me", and for the voice
    /// espeak-ng-data is most of the answer.
    pub fn bytes_in(&self, models_dir: &Path) -> u64 {
        directory_bytes(&self.dir_in(models_dir))
    }

    /// Progress key for the download half — the archive's own file name.
    ///
    /// Built from [`dir`](Self::dir) rather than stored, so a spec cannot name
    /// itself two different things. `$lib/tasks/kinds/model-download` keys the
    /// bar on exactly these strings, which is why they are worth a comment:
    /// changing one changes what a progress bar sums.
    fn download_step(&self) -> String {
        format!("{}.tar.bz2", self.dir)
    }

    /// Progress key for the extraction half. Its total is the archive size too,
    /// so the two halves make one bar that runs 0 → 100% twice over rather than
    /// stalling at 100% for the minute bzip2 takes.
    fn extract_step(&self) -> String {
        format!("{} (unpacking)", self.dir)
    }

    /// Downloads, verifies and unpacks the model into `models_dir`.
    ///
    /// Idempotent: an installed model returns immediately, having reported one
    /// completed step so a caller watching progress does not hang on a bar that
    /// never moves — but not before sweeping what the last run left behind,
    /// which is the only place that sweep can happen. The archive lands beside
    /// the model directory with a `.part` suffix and is verified *before* a
    /// single entry is unpacked; the entries then land in a `.partial`
    /// directory and reach the live path by one rename. So a failed download,
    /// a cancelled unpack and a crash all leave the same thing behind — files
    /// with a suffix nothing reads — and never a half-model where the engine
    /// looks for a whole one.
    pub fn install(&self, models_dir: &Path, on_progress: OnProgress<'_>) -> Result<(), String> {
        let archive = models_dir.join(format!("{}.tar.bz2.part", self.dir));
        let staging = self.staging_in(models_dir);
        // Leftovers from an interrupted run, and neither is ever reused: a
        // range request that half-worked is exactly the kind of thing the hash
        // would catch one download too late, and a staging tree is by
        // definition whatever the interruption stopped mid-write. Swept ahead
        // of the "already installed" answer as well — hundreds of megabytes
        // that nothing will ever read again are not worth keeping for the sake
        // of returning two syscalls sooner.
        let _ = fs::remove_file(&archive);
        let _ = fs::remove_dir_all(&staging);

        if self.installed_in(models_dir) {
            on_progress(&self.download_step(), self.bytes, self.bytes);
            on_progress(&self.extract_step(), self.bytes, self.bytes);
            return Ok(());
        }

        fs::create_dir_all(models_dir)
            .map_err(|e| format!("could not create {}: {e}", models_dir.display()))?;

        self.download(&archive, on_progress)
            .and_then(|_| self.unpack(&archive, &staging, on_progress))
            .and_then(|_| self.commit_staged(&staging, models_dir))
            .inspect_err(|_| {
                // Nothing half-finished survives a failure: the next attempt
                // starts from an empty directory and a fresh request. The live
                // path is not touched, because nothing partial was ever put
                // there to clean up.
                let _ = fs::remove_file(&archive);
                let _ = fs::remove_dir_all(&staging);
            })?;

        fs::remove_file(&archive)
            .map_err(|e| format!("could not remove {}: {e}", archive.display()))
    }

    /// Streams the archive to `archive`, hashing as it goes.
    fn download(&self, archive: &Path, on_progress: OnProgress<'_>) -> Result<(), String> {
        let step = self.download_step();
        on_progress(&step, 0, self.bytes);

        let mut response = ureq::get(self.url)
            .call()
            .map_err(|e| format!("could not reach {}: {e}", self.url))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("{}: HTTP {}", self.url, status.as_u16()));
        }

        let mut body = response.body_mut().as_reader();
        let mut file = File::create(archive)
            .map_err(|e| format!("could not create {}: {e}", archive.display()))?;

        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 256 * 1024];
        let mut loaded: u64 = 0;
        let mut reported: u64 = 0;

        loop {
            let read = body
                .read(&mut buffer)
                .map_err(|e| format!("the download stopped early: {e}"))?;
            if read == 0 {
                break;
            }
            let chunk = &buffer[..read];
            // Fail on the first byte past the pin rather than after another
            // 300 MB of someone else's file.
            loaded += read as u64;
            if loaded > self.bytes {
                return Err(format!(
                    "{} is larger than the expected {} bytes",
                    step, self.bytes
                ));
            }
            hasher.update(chunk);
            file.write_all(chunk)
                .map_err(|e| format!("could not write {}: {e}", archive.display()))?;
            if loaded - reported >= PROGRESS_STEP_BYTES {
                reported = loaded;
                on_progress(&step, loaded, self.bytes);
            }
        }

        file.flush()
            .map_err(|e| format!("could not write {}: {e}", archive.display()))?;
        on_progress(&step, loaded, self.bytes);

        if loaded != self.bytes {
            return Err(format!(
                "{}: expected {} bytes, got {loaded}",
                step, self.bytes
            ));
        }
        let digest = hex(&hasher.finalize());
        if digest != self.sha256 {
            return Err(format!(
                "{}: expected sha256 {}, got {digest}",
                step, self.sha256
            ));
        }
        Ok(())
    }

    /// Unpacks the verified archive into `staging`, where the archive's own
    /// top-level directory becomes the model directory awaiting its rename.
    ///
    /// Never into the live directory: for the whole of this call the tree is
    /// growing, and a tree that is growing is one the engine must not be able
    /// to find. [`commit_staged`](Self::commit_staged) is what publishes it.
    fn unpack(
        &self,
        archive: &Path,
        staging: &Path,
        on_progress: OnProgress<'_>,
    ) -> Result<(), String> {
        let step = self.extract_step();
        on_progress(&step, 0, self.bytes);
        // A previous attempt's remains would make `unpack` fail on a file it
        // cannot overwrite, and a stale entry would survive into the new model.
        let _ = fs::remove_dir_all(staging);
        fs::create_dir_all(staging)
            .map_err(|e| format!("could not create {}: {e}", staging.display()))?;

        let file = File::open(archive)
            .map_err(|e| format!("could not read {}: {e}", archive.display()))?;
        // Progress is measured on the *compressed* side, which is the only
        // total we know before we start: the archive's own pinned size.
        let counted = CountingReader {
            inner: file,
            read: 0,
            reported: 0,
            total: self.bytes,
            step: &step,
            on_progress,
        };
        let decoder = bzip2::read::BzDecoder::new(counted);
        tar::Archive::new(decoder)
            .unpack(staging)
            .map_err(|e| format!("could not unpack {}.tar.bz2: {e}", self.dir))?;
        on_progress(&step, self.bytes, self.bytes);
        Ok(())
    }

    /// Publishes a finished staging tree: the one step an install is visible
    /// from, and the reason nothing else has to defend against a partial one.
    ///
    /// Verifies the staged model first — an archive that unpacked without every
    /// file the engine names is a failed install, and it fails here rather than
    /// where it would kill the process. Then the live path changes in a single
    /// `rename`, which within one directory is atomic: a reader sees the old
    /// tree or the new one and never a mixture.
    ///
    /// Whatever was at the live path is removed immediately before that rename,
    /// and it can only ever be junk: [`install`](Self::install) returns early
    /// when a complete model is already there, so reaching this line means the
    /// live path held nothing, or held something the engine could not have
    /// loaded anyway.
    pub(crate) fn commit_staged(&self, staging: &Path, models_dir: &Path) -> Result<(), String> {
        if !self.installed_in(staging) {
            return Err(format!("{} unpacked but is missing files", self.dir));
        }

        let live = self.dir_in(models_dir);
        let _ = fs::remove_dir_all(&live);
        fs::rename(self.dir_in(staging), &live)
            .map_err(|e| format!("could not move {} into place: {e}", live.display()))?;
        // The archive's top-level directory has moved out; anything else it
        // carried has not, and is not part of the model.
        let _ = fs::remove_dir_all(staging);
        Ok(())
    }
}

/// A `Read` that reports how far through the archive it is.
struct CountingReader<'a, R: Read> {
    inner: R,
    read: u64,
    reported: u64,
    total: u64,
    step: &'a str,
    on_progress: OnProgress<'a>,
}

impl<R: Read> Read for CountingReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.read += read as u64;
        if self.read - self.reported >= PROGRESS_STEP_BYTES {
            self.reported = self.read;
            (self.on_progress)(self.step, self.read.min(self.total), self.total);
        }
        Ok(read)
    }
}

/// Total size of every regular file under `dir`, or 0 if it is not there.
fn directory_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => directory_bytes(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pin_names_an_immutable_release_asset() {
        for spec in [&KOKORO, &SENSE_VOICE] {
            // A tag, not `latest`, and not a branch: the bytes behind this URL
            // may never change, because the size and hash beside it are
            // constants.
            assert!(
                spec.url
                    .starts_with("https://github.com/k2-fsa/sherpa-onnx/releases/download/"),
                "{}",
                spec.url
            );
            // The URL ends in the archive the progress key names, which is what
            // makes one `dir` enough to describe the whole install.
            assert!(spec.url.ends_with(&spec.download_step()), "{}", spec.url);
            assert_eq!(spec.sha256.len(), 64);
            assert!(spec
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
            assert!(!spec.files.is_empty());
        }

        // The published sizes of the two release assets, which is also what
        // each download refuses to exceed by a byte.
        assert_eq!(KOKORO.bytes, 364_816_464);
        assert_eq!(SENSE_VOICE.bytes, 163_002_883);
    }

    #[test]
    fn the_two_progress_keys_of_one_model_are_distinct_and_named_after_it() {
        assert_eq!(
            KOKORO.download_step(),
            "kokoro-multi-lang-v1_1.tar.bz2",
            "the key `tts-model` has always summed"
        );
        assert_eq!(KOKORO.extract_step(), "kokoro-multi-lang-v1_1 (unpacking)");
        assert_ne!(SENSE_VOICE.download_step(), SENSE_VOICE.extract_step());
        assert_ne!(SENSE_VOICE.download_step(), KOKORO.download_step());
    }

    #[test]
    fn an_absent_model_is_neither_installed_nor_counted() {
        let missing = Path::new("/nonexistent/sapling-models");

        assert!(!KOKORO.installed_in(missing));
        assert_eq!(KOKORO.bytes_in(missing), 0);
        assert!(!SENSE_VOICE.installed_in(missing));
    }

    #[test]
    fn a_directory_missing_one_file_is_not_installed() {
        let root = std::env::temp_dir().join(format!("sapling-models-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = KOKORO.dir_in(&root);
        // Every file but the first, each one byte, nested directories included —
        // the list carries paths, not names.
        for file in KOKORO.files.iter().skip(1) {
            let path = dir.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"x").unwrap();
        }

        assert!(!KOKORO.installed_in(&root), "model.onnx is missing");

        fs::write(dir.join(KOKORO.files[0]), b"xyz").unwrap();
        assert!(KOKORO.installed_in(&root));
        assert_eq!(
            KOKORO.bytes_in(&root),
            KOKORO.files.len() as u64 + 2,
            "one 3-byte file and the rest one byte each"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn there_is_always_at_least_one_thread_and_never_more_than_a_phone_should_spend() {
        let threads = available_threads();
        assert!(threads >= 1);
        if !cfg!(desktop) {
            assert!(
                threads <= MOBILE_MAX_THREADS as i32,
                "a phone's slow cluster is not worth an ONNX thread each: {threads}"
            );
        }
    }
}
