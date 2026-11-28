package dev.aura.android.transcript

import dev.aura.android.net.ProtocolJson
import dev.aura.android.protocol.Item
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AuraMessageTest {
    private fun user(text: String) = Item(id = "u", kind = "user_message", text = text)
    private fun system(data: String) = Item(id = "c", kind = "system", data = ProtocolJson.parseToJsonElement(data).jsonObject)

    @Test
    fun `a message from Aura is told by its first line`() {
        val m = AuraMessage.of(user("[Aura] Worker report. This message comes from Aura, not the user.\n\nThe build is green.\n"))
        assertEquals(AuraMessage("Worker report", "The build is green."), m)
        assertEquals(
            AuraMessage("Decision from the user", ""),
            AuraMessage.of(user("[Aura] Decision from the user. This message comes from Aura, not the user.")),
        )
        assertEquals(
            "Question from a teammate",
            AuraMessage.of(user("[Aura] Question from a teammate. This message comes from Aura, not the user.\nWhich port?"))?.title,
        )
    }

    @Test
    fun `what the user wrote is never taken for Aura`() {
        assertNull(AuraMessage.of(user("Fix the build")))
        // Starting like Aura is not enough: the first line must end with the mark.
        assertNull(AuraMessage.of(user("[Aura] Worker report, please summarise it")))
        assertNull(AuraMessage.of(user("Please\n[Aura] Worker report. This message comes from Aura, not the user.")))
        assertNull(AuraMessage.of(user(" [Aura] Worker report. This message comes from Aura, not the user.")))
        // Only user-role messages: an agent quoting it stays the agent's.
        assertNull(AuraMessage.of(Item(id = "a", kind = "agent_message", text = "[Aura] Worker report. This message comes from Aura, not the user.")))
    }

    @Test
    fun `a feature card is a system item pointing into the feature record`() {
        assertEquals(FeatureCardRef("decision", "q1"), FeatureCardRef.of(system("""{"feature_card":{"kind":"decision","id":"q1"},"message":"Which?"}""")))
        assertEquals(FeatureCardRef("report", "report"), FeatureCardRef.of(system("""{"feature_card":{"kind":"report","id":"report"}}""")))
        assertNull(FeatureCardRef.of(system("""{"feature_card":{"kind":"unknown","id":"q1"}}""")))
        assertNull(FeatureCardRef.of(system("""{"feature_card":{"kind":"decision","id":7}}""")))
        assertNull(FeatureCardRef.of(system("""{"feature_card":"decision"}""")))
        assertNull(FeatureCardRef.of(Item(id = "x", kind = "tool_call", data = JsonObject(mapOf()))))
    }

    @Test
    fun `Aura's messages and feature cards get rows of their own, not bubbles or steps`() {
        val items = listOf(
            user("Go"),
            Item(id = "t", kind = "tool_call"),
            system("""{"feature_card":{"kind":"decision","id":"q1"}}""").copy(id = "card"),
            user("[Aura] Decision from the user. This message comes from Aura, not the user.\nShip it.").copy(id = "aura"),
            Item(id = "a", kind = "agent_message", text = "Done"),
        )
        val rows = rows(items)
        assertEquals(listOf(Row.User::class, Row.Work::class, Row.Feature::class, Row.Aura::class, Row.Agent::class), rows.map { it::class })
        assertTrue((rows[3] as Row.Aura).message.body == "Ship it.")
    }
}
