package dev.aura.android.protocol

import kotlinx.serialization.Serializable
import java.util.Locale
import kotlin.math.roundToInt

// The daemon's usage types (crates/aura-core/src/usage.rs): camelCase on the wire.

/** What a set of turns spent. `costUsd` adds reported and estimated costs; unpriced turns count in tokens only. */
@Serializable
data class UsageTotals(
    val turns: Int = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    /** Cache reads and writes. */
    val cachedInputTokens: Long = 0,
    /** The part of [cachedInputTokens] written to the cache. */
    val cacheWriteTokens: Long = 0,
    val costUsd: Double = 0.0,
    val estimatedCostUsd: Double = 0.0,
    val unpricedTurns: Int = 0,
) {
    val tokens: Long get() = inputTokens + outputTokens + cachedInputTokens
    val cacheReadTokens: Long get() = (cachedInputTokens - cacheWriteTokens).coerceAtLeast(0)

    /** Cache reads as a share of all input; null without input. */
    val cacheHitRate: Double? get() {
        val input = inputTokens + cachedInputTokens
        return if (input > 0) cacheReadTokens.toDouble() / input else null
    }
}

/** One group of a summary: a day, a session, a feature, a project, an agent or a model. */
@Serializable
data class UsageGroup(
    val key: String,
    val label: String,
    val totals: UsageTotals = UsageTotals(),
    val parts: List<UsageGroup> = emptyList(),
)

/** `usage.summary`'s answer. */
@Serializable
data class UsageSummary(
    val groupBy: String = "day",
    val totals: UsageTotals = UsageTotals(),
    val groups: List<UsageGroup> = emptyList(),
    val more: Int = 0,
)

/** One turn of a session: what it spent and the context after it. */
@Serializable
data class TurnUsage(
    val turnId: String,
    val at: String = "",
    val model: String? = null,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    val contextUsed: Long? = null,
    val contextWindow: Long? = null,
    val costUsd: Double? = null,
    val estimated: Boolean = false,
) {
    /** How full the context is after the turn, 0..1; null when not known. */
    val contextShare: Double? get() {
        val used = contextUsed ?: return null
        val window = contextWindow?.takeIf { it > 0 } ?: return null
        return used.toDouble() / window
    }
}

/** `usage.session`'s answer. */
@Serializable
data class SessionUsage(
    val sessionId: String,
    val title: String = "",
    val totals: UsageTotals = UsageTotals(),
    val allTotals: UsageTotals = UsageTotals(),
    val turns: List<TurnUsage> = emptyList(),
    val models: List<UsageGroup> = emptyList(),
    val workers: List<UsageGroup> = emptyList(),
)

/** A usage summary in words (`usage.report`, and the daily `usage_report` event). */
@Serializable
data class UsageReport(
    val id: String,
    val title: String = "",
    val from: String = "",
    val to: String = "",
    val generatedAt: String = "",
    val totals: UsageTotals = UsageTotals(),
    val previous: UsageTotals = UsageTotals(),
    val markdown: String = "",
)

/** Tokens, short: 950, 1.2k, 45k, 3.4M (as the daemon's summaries write them). */
fun formatTokens(n: Long): String = when {
    n >= 1_000_000_000 -> String.format(Locale.US, "%.1fB", n / 1e9)
    n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1e6)
    n >= 10_000 -> "${(n / 1e3).roundToInt()}k"
    n >= 1_000 -> String.format(Locale.US, "%.1fk", n / 1e3)
    else -> n.toString()
}

/** Dollars: $123, $4.50, $0.031. */
fun formatCost(c: Double): String = when {
    c >= 100 -> "$" + c.roundToInt()
    c >= 0.995 || c == 0.0 -> String.format(Locale.US, "$%.2f", c)
    else -> String.format(Locale.US, "$%.3f", c)
}

/** A share as a whole percentage. */
fun formatPercent(share: Double): String = "${(share * 100).roundToInt()}%"

/** The compact line under an agent reply: "1.2k in · 300 out · 12k cache · ctx 45% · ~$0.03". */
fun TurnUsage.line(): String = buildList {
    add("${formatTokens(inputTokens)} in")
    add("${formatTokens(outputTokens)} out")
    val cache = cacheReadTokens + cacheWriteTokens
    if (cache > 0) add("${formatTokens(cache)} cache")
    contextShare?.let { add("ctx ${formatPercent(it)}") }
    costUsd?.let { add((if (estimated) "~" else "") + formatCost(it)) }
}.joinToString(" · ")

/** The totals in one line, for a notification: "$1.20 · 1.3M tokens · 42 turns". */
fun UsageTotals.line(): String = buildList {
    if (costUsd > 0 || unpricedTurns < turns) add(formatCost(costUsd))
    add("${formatTokens(tokens)} tokens")
    add("$turns ${if (turns == 1) "turn" else "turns"}")
}.joinToString(" · ")
