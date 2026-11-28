package dev.aura.android.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.tls.HeldCertificate
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
 * AURA_DEMO_MINUTES (default 30; AURA_DEMO_DAEMON=0.6.3 answers like a 0.6.3 daemon) and writes the pairing link to
 * build/demo-pairing-link.txt; any pairing code works.
 */
class DemoAurad {
    @Test
    fun serve() {
        assumeTrue(System.getenv("AURA_DEMO_SERVER") == "1")
        val minutes = System.getenv("AURA_DEMO_MINUTES")?.toLongOrNull() ?: 30
        val demo = DemoData()
        // The same certificate each run, so a paired app stays paired when the demo restarts.
        val pem = File("build/demo-certificate.pem")
        val certificate = if (pem.exists()) {
            HeldCertificate.decode(pem.readText())
        } else {
            HeldCertificate.Builder().commonName("aurad").build().also {
                pem.writeText(it.certificatePem() + it.privateKeyPkcs8Pem())
            }
        }
        FakeAurad(port = 7443, certificate = certificate) { method, params -> demo.answer(method, params) }.use { aurad ->
            demo.attach(aurad)
            aurad.accept(200)
            val link = "aura://pair?host=10.0.2.2&port=7443&fp=${aurad.fingerprint}&code=DEMO2345&name=" +
                URLEncoder.encode("Demo Mac", "UTF-8").replace("+", "%20")
            File("build/demo-pairing-link.txt").writeText(link)
            println(link)
            val end = System.currentTimeMillis() + minutes * 60_000
            var n = 0
            while (System.currentTimeMillis() < end) {
                Thread.sleep(15_000)
                demo.stream(aurad, ++n)
            }
        }
    }
}

private class DemoData {
    private val workspaces = mutableListOf(ws("w1", "Product", 0), ws("w2", "Infra", 1))
    private val approvals = mutableListOf(approval("p1", "m2", "Run openssl s_client", "openssl s_client -connect 10.0.2.2:7443"))
    private var secondQuestion = false
    private val attachmentData = HashMap<String, JsonObject>()
    private val sessions = mutableListOf(
        session("f1", "Ship the Android app", status = "running", featureOwner = true, created = "2026-11-28T08:00:00Z"),
        JsonObject(session("m1", "Session list like the desktop", status = "running", parent = "f1", specialist = "Frontend engineer") + ("model" to str("opus")) + ("effort" to str("high"))),
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
    private var answer: JsonElement = JsonNull
    private var aurad: FakeAurad? = null

    init {
        for (s in sessions) {
            val id = s["id"]!!.jsonPrimitive.content
            val count = if (id == "f1") 30 else 3
            history[id] = (1..count).flatMap { i -> exchange(id, i) }.toMutableList()
        }
        history.getValue("f1") += listOf(
            event("item_completed", "f1", "item" to item("f1-report", "f1", "user_message", AURA_REPORT, "completed")),
            event("item_completed", "f1", "item" to item("f1-md", "f1", "agent_message", MARKDOWN_REPLY, "completed")),
            event("item_completed", "f1", "item" to item("f1-ask", "f1", "agent_message", "Before I hire a release engineer, one decision for you.", "completed")),
            event("item_completed", "f1", "item" to item("f1-card", "f1", "system", "Decision for you: which SDK?", "completed", obj("feature_card" to obj("kind" to str("decision"), "id" to str("q1"))))),
            event("item_completed", "f1", "item" to item("f1-team", "f1", "user_message", AURA_TEAM, "completed")),
        )
    }

    private fun feature() = obj(
        "owner_id" to str("f1"), "goal" to str("Ship the Android app"), "status" to str("waiting_on_user"),
        "updated_at" to str("2026-11-28T09:00:00Z"),
        "team" to JsonArray(listOf(
            obj("worker_id" to str("m1"), "name" to str("Ada"), "role" to str("Frontend engineer")),
            obj("worker_id" to str("m2"), "name" to str("Sam"), "role" to str("Security reviewer")),
            obj("worker_id" to str("m3"), "name" to str("Kim"), "role" to str("Technical writer")),
        )),
        "decisions" to JsonArray(listOf(
            obj("id" to str("d1"), "decision" to str("Use Material 3 with dynamic color"), "rationale" to str("Matches the platform; the user asked for Material You."), "decided_by" to str("user"), "at" to str("2026-11-28T08:10:00Z")),
            obj("id" to str("d2"), "decision" to str("Pin the server certificate by SHA-256"), "rationale" to str("Self-signed certificates; no CA to trust."), "decided_by" to str("owner"), "at" to str("2026-11-28T08:20:00Z")),
        )),
        "checkpoints" to JsonArray(listOf(obj("checkpoint" to str("after_design"), "summary" to str("Screens and flows"), "at" to str("2026-11-28T08:30:00Z"), "approved" to JsonPrimitive(true)))),
        "questions" to JsonArray(listOfNotNull(obj(
            "id" to str("q1"), "question" to str("Target SDK 37 now, or stay on 36 until the BOM catches up?"),
            "context" to str("Compose BOM 2026.11.01 needs **android-37.1**; 37.0 is installed."),
            "options" to JsonArray(listOf(
                obj("label" to str("SDK 37"), "description" to str("Newest platform, BOM 2026.09.00")),
                obj("label" to str("Stay on 36"), "description" to JsonNull),
            )),
            "recommended" to str("SDK 37"), "kind" to str("decision"), "asked_at" to str("2026-11-28T09:30:00Z"),
            "answer" to answer, "withdrawn" to JsonPrimitive(false),
        ), if (secondQuestion) obj(
            "id" to str("q2"), "question" to str("Ship 0.6.2 to the beta channel tonight?"),
            "context" to str("Notifications and workspaces are in; the emulator checks pass."),
            "options" to JsonArray(listOf(obj("label" to str("Ship tonight")), obj("label" to str("Wait for Monday")))),
            "recommended" to str("Ship tonight"), "kind" to str("irreversible"), "asked_at" to str("2026-11-28T10:30:00Z"),
            "answer" to JsonNull, "withdrawn" to JsonPrimitive(false),
        ) else null)),
    )

    private fun approval(id: String, session: String, title: String, command: String) = obj(
        "id" to str(id), "session_id" to str(session), "kind" to str("command"), "title" to str(title),
        "payload" to obj("command" to str(command)),
        "options" to JsonArray(listOf(str("accept"), str("accept_for_session"), str("decline"))),
    )

    private fun replaceSession(id: String, change: (JsonObject) -> JsonObject): JsonObject {
        val i = sessions.indexOfFirst { it["id"]!!.jsonPrimitive.content == id }
        sessions[i] = change(sessions[i])
        aurad?.notify("event", obj("type" to str("session_updated"), "session" to sessions[i]))
        return sessions[i]
    }

    fun answer(method: String, params: JsonObject): JsonElement =
        // AURA_DEMO_DAEMON=0.6.3: a daemon from before these were allowed remotely refuses them.
        if (System.getenv("AURA_DEMO_DAEMON") == "0.6.3" && NEW_IN_064.any { method.startsWith(it) }) {
            FakeAurad.error(-32003, "method not allowed remotely: $method")
        } else {
            answer064(method, params)
        }

    private fun answer064(method: String, params: JsonObject): JsonElement = when (method) {
        "remote.pair" -> obj(
            "deviceId" to str("demo-device"), "token" to str("demo"), "serverId" to str("demo-server"),
            "serverName" to str("Demo Mac"), "version" to str("0.6.0"),
        )
        "remote.auth" -> obj("serverId" to str("demo-server"), "serverName" to str("Demo Mac"), "version" to str("0.6.0"))
        "session.list" -> synchronized(this) { JsonArray(sessions.toList()) }
        "workspace.list" -> synchronized(this) { JsonArray(workspaces.toList()) }
        "provider.list" -> JsonArray(listOf(obj(
            "kind" to str("claude"), "display_name" to str("Claude Code"), "available" to JsonPrimitive(true),
            "capabilities" to obj("structured" to JsonPrimitive(true)), "agents" to JsonArray(emptyList()),
        )))
        "orchestrator.projects" -> JsonArray(listOf(
            obj("path" to str("/Users/me/Projects/aura"), "repo" to JsonPrimitive(true), "sessions" to JsonPrimitive(9), "last_used" to str("2026-11-28")),
            obj("path" to str("/Users/me/Projects/infra"), "repo" to JsonPrimitive(true), "sessions" to JsonPrimitive(2), "last_used" to str("2026-11-27")),
        ))
        "workspace.create" -> synchronized(this) {
            val made = ws("w${workspaces.size + 1}", params["name"]!!.jsonPrimitive.content, workspaces.size)
            workspaces += made
            aurad?.notify("event", obj("type" to str("workspaces_changed"), "workspaces" to JsonArray(workspaces.toList())))
            made
        }
        "session.set_workspace" -> synchronized(this) {
            val id = params["id"]!!.jsonPrimitive.content
            val target = params["workspace"]!!
            val tree = sessions.filter { s -> s["id"]!!.jsonPrimitive.content == id || (s["orchestrator_id"] as? JsonPrimitive)?.content == id }
                .map { it["id"]!!.jsonPrimitive.content }
            JsonArray(tree.map { sid -> replaceSession(sid) { JsonObject(it + ("workspace" to target)) } })
        }
        "session.respond_approval" -> synchronized(this) {
            val approvalId = params["approval_id"]!!.jsonPrimitive.content
            approvals.removeAll { it["id"]!!.jsonPrimitive.content == approvalId }
            aurad?.notify("event", event("approval_resolved", params["id"]!!.jsonPrimitive.content, "approval_id" to str(approvalId), "decision" to params["decision"]!!))
            JsonPrimitive(true)
        }
        "feature.list" -> synchronized(this) { JsonArray(listOf(feature())) }
        "feature.answer" -> synchronized(this) {
            answer = obj("option" to (params["option"] ?: JsonNull), "text" to (params["text"] ?: str("")), "at" to str("2026-11-28T10:00:00Z"), "delivered" to JsonPrimitive(true))
            feature().also { f -> aurad?.notify("event", event("feature_updated", "f1", "feature" to f)) }
        }
        "session.pending" -> obj(
            "approvals" to synchronized(this) { JsonArray(approvals.toList()) },
            "inputs" to JsonArray(listOf(obj(
                "id" to str("i1"), "session_id" to str("s1"),
                "questions" to JsonArray(listOfNotNull(obj(
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
        "session.send" -> synchronized(this) {
            // What the daemon does: the message in the transcript, its images kept as attachments.
            val id = params["id"]!!.jsonPrimitive.content
            val input = params["input"] as JsonObject
            val images = (input["images"] as? JsonArray).orEmpty().map { it as JsonObject }
            val attachments = images.mapIndexed { i, img ->
                val key = "att-${'$'}{attachmentData.size + 1}"
                attachmentData[key] = img
                obj("id" to str(key), "name" to (img["name"] ?: JsonNull), "thumbnail" to (img["thumbnail"] ?: JsonNull),
                    "width" to (img["width"] ?: JsonNull), "height" to (img["height"] ?: JsonNull),
                    "original_width" to (img["original_width"] ?: JsonNull), "original_height" to (img["original_height"] ?: JsonNull))
            }
            val itemId = "sent-${'$'}{System.nanoTime()}"
            val e = event("item_completed", id, "item" to item(itemId, id, "user_message", input["text"]?.jsonPrimitive?.content.orEmpty(), "completed", obj("attachments" to JsonArray(attachments))))
            history.getOrPut(id) { mutableListOf() } += e
            aurad?.notify("event", e)
            JsonPrimitive(true)
        }
        "session.attachment" -> synchronized(this) {
            val img = attachmentData[params["attachment"]!!.jsonPrimitive.content] ?: return@synchronized FakeAurad.error(-32000, "no such attachment")
            obj("data" to img["data"]!!, "media_type" to img["media_type"]!!)
        }
        "session.git_diff" -> str(DEMO_DIFF)
        "session.git_status", "session.git_diff_stat" -> obj("files" to JsonArray(emptyList()), "truncated" to JsonPrimitive(false))
        "session.mark_seen", "session.interrupt", "session.respond_input" -> JsonPrimitive(true)
        else -> FakeAurad.error(-32601, "unknown method $method")
    }

    fun attach(aurad: FakeAurad) {
        this.aurad = aurad
    }

    /**
     * What happens on the server, every 15 s: an approval on a main chat
     * (tick 2), a new decision for the user (3), a main chat finishing with a
     * reply (4); a message streams into the feature owner's chat otherwise.
     */
    fun stream(aurad: FakeAurad, n: Int) {
        this.aurad = aurad
        when (n) {
            2 -> synchronized(this) {
                val a = approval("p2", "s2", "Run the database migration", "./gradlew flywayMigrate")
                approvals += a
                aurad.notify("event", event("approval_requested", "s2", "approval" to a))
                replaceSession("s2") { JsonObject(it + ("status" to str("waiting_approval")) + ("pending_count" to JsonPrimitive(1))) }
                return
            }
            3 -> synchronized(this) {
                secondQuestion = true
                aurad.notify("event", event("feature_updated", "f1", "feature" to feature()))
                return
            }
            4 -> synchronized(this) {
                val reply = "The store is split into three slices; the tests pass and the bundle is 14 KB smaller."
                aurad.notify("event", event("item_completed", "s2", "item" to item("s2-done", "s2", "agent_message", reply, "completed")))
                replaceSession("s2") {
                    JsonObject(it + ("status" to str("idle")) + ("attention" to str("done")) + ("last_activity" to str("2026-11-28T10:40:00Z")))
                }
                return
            }
        }
        val id = "live$n"
        // Long and Markdown-heavy, in small pieces: a fence and a table open and close mid-stream.
        val part = "### Update $n\n\nThe session list now groups by **workspace** and status, and workers are tabs in their session.\n\n" +
            "```kotlin\nfun update(n: Int) {\n    println(\"update ${'$'}n\")\n}\n```\n\n| Screen | State |\n|---|---|\n| Sessions | done |\n| Team | done |\n\n- one\n- two\n- three"
        // As long as a real agent's answer: the same blocks again and again.
        val text = (1..20).joinToString("\n\n") { part.replace("### Update $n", if (it == 1) "### Update $n" else "#### Part $it") }
        fun send(e: JsonObject) {
            synchronized(this) { if (e["type"]!!.jsonPrimitive.content != "item_delta") history.getValue("f1") += e }
            aurad.notify("event", e)
        }
        send(event("item_started", "f1", "item" to item(id, "f1", "agent_message", "", "in_progress")))
        text.chunked(12).forEach {
            send(event("item_delta", "f1", "item_id" to str(id), "delta" to obj("kind" to str("text"), "text" to str(it))))
            Thread.sleep(20)
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

private const val AURA_REPORT = "[Aura] Worker report. This message comes from Aura, not the user.\n\n" +
    "**Frontend engineer** finished: the session list groups by workspace and status, and workers are tabs."
private const val AURA_TEAM = "[Aura] Question from a teammate. This message comes from Aura, not the user.\n\n" +
    "Security reviewer asks: may I run `openssl s_client` against the demo server?"

private const val MARKDOWN_REPLY = """## Status

The **session list** now mirrors the desktop, ~~flat list~~ no more. Run `./gradlew lint` to check.

- [x] Grouped by workspace
- [ ] Notifications
  - decisions
  - replies

| Screen | State |
|---|---|
| Sessions | done |
| Team | in progress |

```kotlin
fun greet(name: String) = "Hello, ${'$'}name"
```

> Quoted from the spec.

---

See [the design doc](https://example.com/design)."""

private const val DEMO_DIFF = """diff --git a/apps/android/app/src/main/java/dev/aura/android/ui/session/FollowLatest.kt b/apps/android/app/src/main/java/dev/aura/android/ui/session/FollowLatest.kt
index 1111111..2222222 100644
--- a/apps/android/app/src/main/java/dev/aura/android/ui/session/FollowLatest.kt
+++ b/apps/android/app/src/main/java/dev/aura/android/ui/session/FollowLatest.kt
@@ -40,9 +40,11 @@ class FollowLatest internal constructor(
     /** Called with the transcript's size on every change. */
     @Composable
-    fun Track(count: Int, newestKey: Any?, newestLength: Int) {
+    fun Track(count: Int) {
         this.count = count
-        LaunchedEffect(count, newestKey, newestLength) {
-            if (pinned && !list.isScrollInProgress) list.scrollToItem(0)
+        LaunchedEffect(count) { if (pinned) seen = count }
+    }
+
+    internal suspend fun follow() {
+        snapshotFlow { pinned && !list.isScrollInProgress && list.canScrollForward }
         }
     }
diff --git a/README.md b/README.md
new file mode 100644
--- /dev/null
+++ b/README.md
@@ -0,0 +1,3 @@
+# Aura for Android
+
+Streaming replies no longer make the transcript jump.
"""

/** What a 0.6.3 daemon refuses remotely (-32003): its remote allowlist gained these in 0.6.4. */
private val NEW_IN_064 = listOf("session.git_", "usage.", "template.")
