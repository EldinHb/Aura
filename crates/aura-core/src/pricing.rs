//! Estimated model prices, in US dollars per million tokens.
//!
//! **These are estimates.** They are the providers' published list prices as
//! Aura last knew them, for when an agent does not report what a turn cost
//! (Codex never does). A turn whose agent reported a cost uses that cost,
//! never this table. A model that is not listed here, or a price that is not
//! known (`None`), leaves the turn without a cost: Aura then shows its tokens
//! only. Add a model here only with a price you are sure of.

/// One model's list price, USD per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    /// Cached input read back. None: not known.
    pub cache_read: Option<f64>,
    /// Input written to the cache. None: not known (or not charged apart).
    pub cache_write: Option<f64>,
}

const fn p(
    input: f64,
    output: f64,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
) -> ModelPrice {
    ModelPrice {
        input,
        output,
        cache_read,
        cache_write,
    }
}

/// Model id (as normalized by [`normalize_model`]) and its price.
const PRICES: &[(&str, ModelPrice)] = &[
    // Anthropic (first-party API list prices).
    ("claude-fable-5-2", p(8.0, 40.0, Some(0.20), None)),
    ("claude-fable-5-1", p(10.0, 50.0, None, None)),
    ("claude-fable-5", p(10.0, 50.0, None, None)),
    ("claude-opus-5-5", p(4.0, 20.0, Some(0.20), None)),
    ("claude-opus-5", p(5.0, 25.0, None, None)),
    ("claude-opus-4-8", p(5.0, 25.0, None, None)),
    ("claude-opus-4-7", p(5.0, 25.0, None, None)),
    ("claude-opus-4-6", p(5.0, 25.0, Some(0.50), Some(6.25))),
    ("claude-opus-4-5", p(5.0, 25.0, Some(0.50), Some(6.25))),
    ("claude-sonnet-5-5", p(2.0, 10.0, Some(0.10), None)),
    ("claude-sonnet-5", p(2.0, 10.0, None, None)),
    ("claude-sonnet-4-6", p(3.0, 15.0, Some(0.30), Some(3.75))),
    ("claude-sonnet-4-5", p(3.0, 15.0, Some(0.30), Some(3.75))),
    ("claude-haiku-5-5", p(0.10, 0.50, None, None)),
    ("claude-haiku-4-5", p(1.0, 5.0, Some(0.10), Some(1.25))),
    // OpenAI (Codex). Cached input is billed at the cache-read price.
    ("gpt-5", p(1.25, 10.0, Some(0.125), None)),
    ("gpt-5-codex", p(1.25, 10.0, Some(0.125), None)),
    ("gpt-5-mini", p(0.25, 2.0, Some(0.025), None)),
];

/// A model name as agents report it, reduced to the id the table uses:
/// lower case, without a provider prefix (`anthropic.`, `openai/`), a
/// context suffix (`[1m]`) or a date snapshot (`-20251101`).
pub fn normalize_model(model: &str) -> String {
    let mut m = model.trim().to_ascii_lowercase();
    if let Some(i) = m.find('[') {
        m.truncate(i);
    }
    for prefix in ["anthropic.", "anthropic/", "openai/"] {
        if let Some(rest) = m.strip_prefix(prefix) {
            m = rest.to_string();
        }
    }
    // A trailing date snapshot: -YYYYMMDD or -YYYY-MM-DD.
    let bytes = m.as_bytes();
    let digits = |s: &[u8]| s.iter().all(u8::is_ascii_digit);
    if m.len() > 9 && bytes[m.len() - 9] == b'-' && digits(&bytes[m.len() - 8..]) {
        m.truncate(m.len() - 9);
    } else if m.len() > 11
        && bytes[m.len() - 11] == b'-'
        && digits(&bytes[m.len() - 10..m.len() - 6])
        && bytes[m.len() - 6] == b'-'
        && digits(&bytes[m.len() - 5..m.len() - 3])
        && bytes[m.len() - 3] == b'-'
        && digits(&bytes[m.len() - 2..])
    {
        m.truncate(m.len() - 11);
    }
    m.trim_end_matches('-').to_string()
}

/// The estimated price of `model`, if Aura knows it.
pub fn price(model: &str) -> Option<ModelPrice> {
    let id = normalize_model(model);
    PRICES.iter().find(|(m, _)| *m == id).map(|(_, p)| *p)
}

/// How a provider counts cached input against its input tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CachedTokens {
    /// Input tokens exclude the cached ones (Claude).
    Separate,
    /// Input tokens include the cached ones (Codex / OpenAI).
    Included,
}

/// The estimated cost of a turn: `cached` input tokens of which `written`
/// went into the cache, the rest read from it. None when the model's price,
/// or the price of the cache use the turn had, is not known.
pub fn estimate(
    model: &str,
    input: u64,
    output: u64,
    cached: u64,
    written: u64,
    counting: CachedTokens,
) -> Option<f64> {
    let price = price(model)?;
    let uncached = match counting {
        CachedTokens::Separate => input,
        CachedTokens::Included => input.saturating_sub(cached),
    };
    let written = written.min(cached);
    let read = cached - written;
    let mut cost = uncached as f64 * price.input + output as f64 * price.output;
    if read > 0 {
        cost += read as f64 * price.cache_read?;
    }
    if written > 0 {
        cost += written as f64 * price.cache_write?;
    }
    Some(cost / 1_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_names_are_normalized() {
        assert_eq!(
            normalize_model("claude-opus-4-5-20251101"),
            "claude-opus-4-5"
        );
        assert_eq!(normalize_model("Claude-Opus-5-5[1m]"), "claude-opus-5-5");
        assert_eq!(
            normalize_model("anthropic.claude-sonnet-4-6"),
            "claude-sonnet-4-6"
        );
        assert_eq!(normalize_model("gpt-5-codex"), "gpt-5-codex");
        assert_eq!(normalize_model("gpt-5-2025-08-07"), "gpt-5");
    }

    #[test]
    fn known_models_are_estimated_and_unknown_ones_are_not() {
        // 1M uncached input at $1.25 + 1M output at $10.
        let c = estimate(
            "gpt-5-codex",
            2_000_000,
            1_000_000,
            1_000_000,
            0,
            CachedTokens::Included,
        )
        .unwrap();
        assert!((c - (1.25 + 10.0 + 0.125)).abs() < 1e-9, "{c}");
        let c = estimate(
            "claude-sonnet-4-6",
            1_000_000,
            0,
            0,
            0,
            CachedTokens::Separate,
        )
        .unwrap();
        assert!((c - 3.0).abs() < 1e-9);
        assert_eq!(
            estimate("some-local-model", 10, 10, 0, 0, CachedTokens::Separate),
            None
        );
        assert_eq!(estimate("opus", 10, 10, 0, 0, CachedTokens::Separate), None);
        // A cache-read price that is not known leaves cached turns unpriced.
        assert_eq!(
            estimate("claude-opus-5", 10, 10, 5, 0, CachedTokens::Separate),
            None
        );
        assert!(estimate("claude-opus-5", 10, 10, 0, 0, CachedTokens::Separate).is_some());
        // Reads and writes at their own prices: 1M read at $0.30, 1M written at $3.75.
        let c = estimate(
            "claude-sonnet-4-6",
            0,
            0,
            2_000_000,
            1_000_000,
            CachedTokens::Separate,
        )
        .unwrap();
        assert!((c - 4.05).abs() < 1e-9, "{c}");
        // A write price that is not known leaves turns that wrote the cache unpriced.
        assert_eq!(
            estimate("claude-opus-5-5", 0, 0, 10, 5, CachedTokens::Separate),
            None
        );
    }
}
