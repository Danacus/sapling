//! The one random source: SplitMix64, seeded from the OS or by a caller that
//! wants a replay. Shuffles, tie-breaks, reading rolls and minted ids all draw
//! from it; a function that rolls takes `&mut dyn FnMut() -> f64` so a test can
//! rig the draws.

pub struct Rng(u64);

impl Rng {
    pub fn seeded(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn from_entropy() -> Self {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).expect("an entropy source");
        Rng(u64::from_le_bytes(bytes))
    }

    /// Seeded when the caller named a seed, from the OS otherwise.
    pub fn from_seed(seed: Option<u64>) -> Self {
        seed.map_or_else(Rng::from_entropy, Rng::seeded)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, 1)`, as `Math.random` draws.
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Fisher-Yates.
    pub fn shuffle<T>(&mut self, values: &mut [T]) {
        for i in (1..values.len()).rev() {
            let j = (self.next_u64() % (i as u64 + 1)) as usize;
            values.swap(i, j);
        }
    }

    /// A version-4 UUID, as `crypto.randomUUID()` writes one.
    pub fn uuid(&mut self) -> String {
        let hi = self.next_u64();
        let lo = self.next_u64();
        let hi = (hi & !0xF000) | 0x4000;
        let lo = (lo & !(0b11 << 62)) | (0b10 << 62);
        format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            hi >> 32,
            (hi >> 16) & 0xFFFF,
            hi & 0xFFFF,
            lo >> 48,
            lo & 0xFFFF_FFFF_FFFF
        )
    }
}

/// Fisher-Yates over a copy, drawing as the TypeScript shuffle did: `j` is
/// `floor(draw * (i + 1))`.
pub fn shuffled<T: Clone>(values: &[T], draw: &mut dyn FnMut() -> f64) -> Vec<T> {
    let mut out = values.to_vec();
    for i in (1..out.len()).rev() {
        let j = ((draw() * (i + 1) as f64).floor() as usize).min(i);
        out.swap(i, j);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seeded_rng_replays_and_mints_v4_uuids() {
        let (mut a, mut b) = (Rng::seeded(7), Rng::seeded(7));
        assert_eq!(a.next_u64(), b.next_u64());
        let id = a.uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!("89ab".contains(&id[19..20]));
        let draw = a.next_f64();
        assert!((0.0..1.0).contains(&draw));
    }

    #[test]
    fn a_shuffle_is_a_permutation_decided_by_the_draws() {
        let mut low = || 0.0;
        assert_eq!(shuffled(&[1, 2, 3], &mut low), [2, 3, 1]);
        let mut high = || 0.999;
        assert_eq!(shuffled(&[1, 2, 3], &mut high), [1, 2, 3]);
    }
}
