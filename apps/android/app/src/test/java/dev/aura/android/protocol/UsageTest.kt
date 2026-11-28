package dev.aura.android.protocol

import dev.aura.android.net.ProtocolJson
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import dev.aura.android.ui.usage.ianaZone
import java.time.ZoneId

class UsageTest {
    private fun event(json: String): Event? = Event.parse(ProtocolJson.parseToJsonElement(json).jsonObject)

    @Test
    fun `a summary as the daemon sends it is read, unknown fields ignored`() {
        val s = ProtocolJson.decodeFromString(
            UsageSummary.serializer(),
            """{"from":null,"to":null,"groupBy":"model","more":2,"future":1,
               "totals":{"turns":3,"inputTokens":1000,"outputTokens":200,"cachedInputTokens":800,"cacheWriteTokens":300,
                         "costUsd":1.5,"estimatedCostUsd":0.5,"unpricedTurns":1},
               "groups":[{"key":"gpt-5","label":"gpt-5","totals":{"turns":1},"parts":[]}]}""",
        )
        assertEquals(2, s.more)
        assertEquals(2000L, s.totals.tokens)
        assertEquals(500L, s.totals.cacheReadTokens)
        assertEquals(500.0 / 1800, s.totals.cacheHitRate!!, 1e-9)
        assertEquals("gpt-5", s.groups.single().label)
    }

    @Test
    fun `session usage keeps each turn's context and cost`() {
        val u = ProtocolJson.decodeFromString(
            SessionUsage.serializer(),
            """{"sessionId":"s","title":"T","totals":{},"allTotals":{},"models":[],"workers":[],
               "turns":[{"turnId":"t1","at":"2026-11-01T10:00:00Z","model":null,"inputTokens":1200,"outputTokens":300,
                         "cacheReadTokens":9000,"cacheWriteTokens":3000,"contextUsed":90000,"contextWindow":200000,
                         "costUsd":0.031,"estimated":true}]}""",
        )
        val t = u.turns.single()
        assertEquals(0.45, t.contextShare!!, 1e-9)
        assertEquals("1.2k in · 300 out · 12k cache · ctx 45% · ~$0.031", t.line())
    }

    @Test
    fun `the usage line leaves out what is not known`() {
        assertEquals("10 in · 5 out", TurnUsage("t", inputTokens = 10, outputTokens = 5).line())
        assertEquals("2.5M in · 0 out · $12.00", TurnUsage("t", inputTokens = 2_500_000, costUsd = 12.0).line())
        assertNull(TurnUsage("t", contextUsed = 5, contextWindow = 0).contextShare)
    }

    @Test
    fun `tokens and costs are written short`() {
        assertEquals("999", formatTokens(999))
        assertEquals("1.5k", formatTokens(1_500))
        assertEquals("45k", formatTokens(45_000))
        assertEquals("3.4M", formatTokens(3_400_000))
        assertEquals("$0.00", formatCost(0.0))
        assertEquals("$0.031", formatCost(0.031))
        assertEquals("$4.50", formatCost(4.5))
        assertEquals("$123", formatCost(123.4))
        assertEquals("$1.20 · 1.3M tokens · 42 turns", UsageTotals(turns = 42, inputTokens = 1_300_000, costUsd = 1.2).line())
        assertEquals("900 tokens · 1 turn", UsageTotals(turns = 1, inputTokens = 900, unpricedTurns = 1).line())
    }

    @Test
    fun `template and usage report events are read`() {
        val templates = event(
            """{"type":"templates_changed","templates":[{"id":"a","created_at":"x","updated_at":"y","name":"Review",
                "kind":"feature_owner","provider":"claude","agent":null,"cwd":"/src/app","worktree":true,
                "branch_pattern":"review/{slug}","workspace":null,"group":null,"mode":null,"command":null,"model":"opus",
                "effort":"high","permission_mode":"plan","sandbox_mode":null,
                "autonomy":{"level":"checkpoints","checkpoints":["after_design"]},"system_prompt":"Be brief.","prompt":"Ship it"}]}""",
        ) as Event.TemplatesChanged
        val t = templates.templates.single()
        assertEquals("review/{slug}", t.branchPattern)
        assertEquals("plan", t.permissionMode)
        assertEquals(Autonomy("checkpoints", listOf("after_design")), t.autonomy)
        assertTrue(t.startableHere)
        assertNull(templates.sessionId)

        val report = event(
            """{"type":"usage_report","report":{"id":"r1","title":"Last 24 hours","from":"a","to":"b","generatedAt":"c",
                "totals":{"turns":2,"costUsd":0.5},"previous":{},"markdown":"## Usage summary"}}""",
        ) as Event.UsageReported
        assertEquals("r1", report.report.id)
        assertEquals(2, report.report.totals.turns)
    }

    @Test
    fun `a terminal template cannot be started from the phone`() {
        assertTrue(!SessionTemplate(id = "a", name = "Shell", provider = "terminal").startableHere)
        assertTrue(!SessionTemplate(id = "a", name = "TUI", provider = "claude", mode = "terminal").startableHere)
    }

    @Test
    fun theServerGetsTheZonesNameNotJustItsOffset() {
        assertEquals("Europe/Amsterdam", ianaZone(ZoneId.of("Europe/Amsterdam")))
        assertNull(ianaZone(ZoneId.of("+02:00")))
        assertNull(ianaZone(ZoneId.of("UTC")))
    }
}
