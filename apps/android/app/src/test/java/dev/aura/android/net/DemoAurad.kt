package dev.aura.android.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.URLEncoder

/**
 * Not a test: a demo server for trying the app on an emulator, with
 * workspaces, an orchestrator and a feature owner with workers, scheduled
 * runs and a long transcript that keeps streaming. It runs only when asked:
 *
 *     AURA_DEMO_SERVER=1 ./gradlew testDebugUnitTest --tests '*DemoAurad*' --rerun
 *
 * It listens on 127.0.0.1:7443 (the emulator's 10.0.2.2) for
 * AURA_DEMO_MINUTES (default 30) and writes the pairing link to
 * build/demo-pairing-link.txt; any pairing code works.
 */
class DemoAurad {
    @Test
    fun serve() {
        assumeTrue(System.getenv("AURA_DEMO_SERVER") == "1")
        val minutes = System.getenv("AURA_DEMO_MINUTES")?.toLongOrNull() ?: 30
        val demo = DemoData()
        FakeAurad(port = 7443) { method, params -> demo.answer(method, params) }.use { aurad ->
            aurad.accept(200)
            val link = "aura://pair?host=10.0.2.2&port=7443&fp=${aurad.fingerprint}&code=DEMO2345&name=" +
                URLEncoder.encode("Demo Mac", "UTF-8").replace("+", "%20")
            File("build/demo-pairing-link.txt").writeText(link)
            println(link)
            val end = System.currentTimeMillis() + minutes * 60_000
            var n = 0
            while (System.currentTimeMillis() < end) {
                Thread.sleep(4_000)
                demo.stream(aurad, ++n)
            }
        }
    }
}

private class DemoData {
    private val workspaces = listOf(ws("w1", "Product", 0), ws("w2", "Infra", 1))
    private val sessions = mutableListOf(
        session("f1", "Ship the Android app", status = "running", featureOwner = true, created = "2026-11-28T08:00:00Z"),
        session("m1", "Session list like the desktop", status = "running", parent = "f1", specialist = "Frontend engineer"),
        session("m2", "Review the pinning", status = "waiting_approval", pending = 1, parent = "f1", specialist = "Security reviewer"),
        session("m3", "Write the README", parent = "f1", specialist = "Technical writer"),
        session("o1", "Release 0.6.0", orchestrator = true, created = "2026-11-27T10:00:00Z"),
        session("o1a", "Changelog", status = "running", parent = "o1"),
        session("o1b", "Bump versions", parent = "o1"),
        session("s1", "Fix the flaky sidebar test", status = "waiting_input", pending = 1),
        session("s2", "Refactor the store", status = "running", cwd = "/Users/me/Projects/aura-web"),
        session("s3", "Docs pass", attention = "done"),
        session("s4", "Bump Terraform providers", workspace = "w2", cwd = "/Users/me/Projects/infra"),
        session("s5", "Plan the staging cluster", status = "running", workspace = "w2", cwd = "/Users/me/Projects/infra"),
        session("r1", "Nightly dependency audit", task = "t1", taskName = "Nightly dependency audit", created = "2026-11-27T02:00:00Z"),
        session("r2", "Nightly dependency audit", task = "t1", taskName = "Nightly dependency audit", attention = "done", created = "2026-11-28T02:00:00Z"),
        session("r3", "Weekly report", task = "t2", taskName = "Weekly report", created = "2026-11-24T07:00:00Z"),
    )
    private val history = HashMap<String, MutableList<JsonObject>>()

    init {
        for (s in sessions) {
            val id = s["id"]!!.jsonPrimitive.content
            val count = if (id == "f1") 30 else 3
            history[id] = (1..count).flatMap { i -> exchange(id, i) }.toMutableList()
        }
    }

    fun answer(method: String, params: JsonObject): JsonElement = when (method) {
        "remote.pair" -> obj(
            "deviceId" to str("demo-device"), "token" to str("demo"), "serverId" to str("demo-server"),
            "serverName" to str("Demo Mac"), "version" to str("0.6.0"),
        )
        "remote.auth" -> obj("serverId" to str("demo-server"), "serverName" to str("Demo Mac"), "version" to str("0.6.0"))
        "session.list" -> synchronized(this) { JsonArray(sessions.toList()) }
        "workspace.list" -> JsonArray(workspaces)
        "feature.list" -> JsonArray(emptyList())
        "session.pending" -> obj(
            "approvals" to JsonArray(listOf(obj(
                "id" to str("p1"), "session_id" to str("m2"), "kind" to str("command"), "title" to str("Run openssl s_client"),
                "payload" to obj("command" to str("openssl s_client -connect 10.0.2.2:7443")),
                "options" to JsonArray(listOf(str("accept"), str("accept_for_session"), str("decline"))),
            ))),
            "inputs" to JsonArray(listOf(obj(
                "id" to str("i1"), "session_id" to str("s1"),
                "questions" to JsonArray(listOf(obj(
                    "id" to str("q"), "question" to str("Keep the retry, or fix the race?"),
                    "options" to JsonArray(listOf(obj("label" to str("Fix the race")), obj("label" to str("Keep the retry")))),
                    "multi_select" to JsonPrimitive(false), "allow_free_text" to JsonPrimitive(true), "secret" to JsonPrimitive(false),
                ))),
            ))),
        )
        "session.history" -> synchronized(this) {
            val id = params["id"]!!.jsonPrimitive.content
            val after = params["after_seq"]?.jsonPrimitive?.long ?: 0
            val limit = params["limit"]?.jsonPrimitive?.long?.toInt() ?: 5000
            JsonArray(history[id].orEmpty().mapIndexed { i, e -> obj("seq" to JsonPrimitive(i + 1), "ts" to str("2026-11-28T09:00:00Z"), "event" to e) }
                .drop(after.toInt()).take(limit))
        }
        "session.mark_seen", "session.send", "session.interrupt", "session.respond_approval", "session.respond_input" -> JsonPrimitive(true)
        else -> FakeAurad.error(-32601, "unknown method $method")
    }

    /** A new agent message in the feature owner's chat, streamed. */
    fun stream(aurad: FakeAurad, n: Int) {
        val id = "live$n"
        val text = "Update $n: the session list now groups by workspace and status, and workers are tabs in their session."
        fun send(e: JsonObject) {
            synchronized(this) { if (e["type"]!!.jsonPrimitive.content != "item_delta") history.getValue("f1") += e }
            aurad.notify("event", e)
        }
        send(event("item_started", "f1", "item" to item(id, "f1", "agent_message", "", "in_progress")))
        text.chunked(24).forEach {
            send(event("item_delta", "f1", "item_id" to str(id), "delta" to obj("kind" to str("text"), "text" to str(it))))
            Thread.sleep(80)
        }
        send(event("item_completed", "f1", "item" to item(id, "f1", "agent_message", text, "completed")))
    }

    private fun exchange(session: String, i: Int): List<JsonObject> {
        val u = "$session-u$i"
        val c = "$session-c$i"
        val a = "$session-a$i"
        return listOf(
            event("item_completed", session, "item" to item(u, session, "user_message", "Step $i: what is next?", "completed")),
            event("item_completed", session, "item" to item(c, session, "command_exec", "", "completed", obj("command" to str("./gradlew test"), "output" to str("BUILD SUCCESSFUL")))),
            event("item_completed", session, "item" to item(a, session, "agent_message", "**Step $i** is done. Tests pass; next I look at `SessionList.kt`.", "completed")),
        )
    }

    private fun ws(id: String, name: String, position: Int) = obj("id" to str(id), "name" to str(name), "created_at" to str("2026-11-01T00:00:00Z"), "position" to JsonPrimitive(position))

    private fun session(
        id: String,
        title: String,
        status: String = "idle",
        pending: Int = 0,
        attention: String? = null,
        parent: String? = null,
        specialist: String? = null,
        orchestrator: Boolean = false,
        featureOwner: Boolean = false,
        workspace: String = "w1",
        cwd: String = "/Users/me/Projects/aura",
        task: String? = null,
        taskName: String? = null,
        created: String = "2026-11-28T09:00:00Z",
    ) = obj(
        "id" to str(id), "provider" to str("claude"), "cwd" to str(cwd), "title" to str(title), "workspace" to str(workspace),
        "status" to str(status), "mode" to str("structured"), "pending_count" to JsonPrimitive(pending),
        "attention" to (attention?.let(::str) ?: JsonNull), "orchestrator_id" to (parent?.let(::str) ?: JsonNull),
        "specialist_name" to (specialist?.let(::str) ?: JsonNull), "orchestrator" to JsonPrimitive(orchestrator || featureOwner),
        "feature_owner" to JsonPrimitive(featureOwner), "scheduled_task_id" to (task?.let(::str) ?: JsonNull),
        "scheduled_task_name" to (taskName?.let(::str) ?: JsonNull), "scheduled_run" to (task?.let(::str) ?: JsonNull),
        "created_at" to str(created), "last_activity" to str(created), "archived" to JsonPrimitive(false), "pinned" to JsonPrimitive(false),
    )

    private fun item(id: String, session: String, kind: String, text: String, status: String, data: JsonObject = obj()) = obj(
        "id" to str(id), "session_id" to str(session), "kind" to str(kind), "status" to str(status), "text" to str(text), "data" to data,
        "started_at" to str("2026-11-28T09:00:00Z"),
    )

    private fun event(type: String, session: String, vararg fields: Pair<String, JsonElement>) =
        obj("type" to str(type), "session_id" to str(session), *fields)

    private fun obj(vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf(*fields))

    private fun str(s: String) = JsonPrimitive(s)
}
