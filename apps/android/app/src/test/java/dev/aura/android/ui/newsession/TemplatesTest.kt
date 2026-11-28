package dev.aura.android.ui.newsession

import dev.aura.android.net.ProtocolJson
import dev.aura.android.protocol.Autonomy
import dev.aura.android.protocol.SessionTemplate
import dev.aura.android.protocol.TemplateInput
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

class TemplatesTest {
    private val now = LocalDateTime.of(2026, 11, 28, 9, 5)
    private val claude = AgentChoice("claude", null, "Claude Code")
    private val codex = AgentChoice("codex", null, "Codex")
    private val gemini = AgentChoice("acp", "gemini", "Gemini")
    private val agents = listOf(claude, codex, gemini)

    @Test
    fun `branch patterns fill in the title, date and time`() {
        assertEquals("aura/fix-login-20261128", expandBranch(DEFAULT_BRANCH_PATTERN, "Fix login!", "Review", now))
        assertEquals("review/review-prs-0905", expandBranch("review/{slug}-{time}", "", "Review PRs", now))
        assertEquals("x/session", expandBranch("x/{slug}", "", "", now))
        assertEquals("a-b", expandBranch("a b", "", "", now))
    }

    @Test
    fun `a template fills every option of the form`() {
        val t = SessionTemplate(
            id = "t", name = "Nightly review", kind = "orchestrator", provider = "acp", agent = "gemini",
            cwd = "/src/app", worktree = true, branchPattern = "review/{slug}-{date}", workspace = "w2", group = "ops",
            model = "pro", effort = "high", permissionMode = "plan", sandboxMode = "read-only",
            systemPrompt = "Be brief.", prompt = "Review the open PRs",
        )
        val f = applyTemplate(NewSessionForm(title = "Thursday"), t, agents, now)
        assertEquals(SessionKind.Orchestrator, f.kind)
        assertEquals(2, f.agentIndex)
        assertEquals("/src/app", f.project)
        assertTrue(f.orchestratorFolder)
        assertTrue(f.worktree)
        assertEquals("review/thursday-20261128", f.branch)
        assertFalse("the branch still follows the title", f.branchTouched)
        assertEquals("w2", f.workspace)
        assertEquals("ops", f.group)
        assertEquals("pro", f.model)
        assertEquals("high", f.effort)
        assertEquals("plan", f.permission)
        assertEquals("read-only", f.sandbox)
        assertEquals("Be brief.", f.systemPrompt)
        assertEquals("Review the open PRs", f.prompt)
        assertEquals("Thursday", f.title)
        assertEquals("Nightly review", f.templateName)
    }

    @Test
    fun `a feature owner's prompt is its goal, and an orchestrator without a folder gets none`() {
        val t = SessionTemplate(
            id = "t", name = "Owner", kind = "feature_owner", provider = "claude",
            autonomy = Autonomy(Autonomy.AUTONOMOUS), prompt = "Build checkout",
        )
        val f = applyTemplate(NewSessionForm(project = "/src/app", prompt = "keep"), t, agents, now)
        assertEquals("Build checkout", f.goal)
        assertEquals("keep", f.prompt)
        assertEquals(Autonomy(Autonomy.AUTONOMOUS), f.autonomy)
        assertTrue(f.noFolder)
        assertEquals("", createOpts(f, claude, isRepo = true).cwd)
    }

    @Test
    fun `an agent the server no longer has falls back to the first`() {
        val f = applyTemplate(NewSessionForm(), SessionTemplate(id = "t", name = "X", provider = "acp", agent = "gone"), agents, now)
        assertEquals(0, f.agentIndex)
    }

    @Test
    fun `the form saves as a template with what it sets`() {
        val form = NewSessionForm(
            project = " /src/app ", worktree = true, branch = "aura/thing", title = "Thing",
            model = "opus", permission = "plan", prompt = " Do it ", systemPrompt = " ", group = "",
        )
        val auto = templateInput(" Mine ", form, codex)
        assertEquals("Mine", auto.name)
        assertEquals("agent", auto.kind)
        assertEquals("codex", auto.provider)
        assertEquals("/src/app", auto.cwd)
        assertTrue(auto.worktree)
        assertNull("a branch that followed the title is not kept", auto.branchPattern)
        assertEquals("opus", auto.model)
        assertNull(auto.effort)
        assertNull(auto.systemPrompt)
        assertNull(auto.group)
        assertEquals("Do it", auto.prompt)
        assertEquals("aura/fixed", templateInput("M", form.copy(branch = "aura/fixed", branchTouched = true), codex).branchPattern)

        val owner = templateInput(
            "Owner",
            NewSessionForm(kind = SessionKind.FeatureOwner, goal = "Build it", prompt = "ignored", autonomy = Autonomy.DEFAULT, worktree = true),
            gemini,
        )
        assertEquals("feature_owner", owner.kind)
        assertEquals("gemini", owner.agent)
        assertNull("no folder", owner.cwd)
        assertFalse("no worktree without a folder", owner.worktree)
        assertEquals("Build it", owner.prompt)
        assertEquals(Autonomy.DEFAULT, owner.autonomy)
        val wire = ProtocolJson.encodeToJsonElement(TemplateInput.serializer(), owner).jsonObject
        assertEquals("\"feature_owner\"", wire["kind"].toString())
    }

    @Test
    fun `a template saved from the form fills the same form back`() {
        val form = NewSessionForm(
            kind = SessionKind.Orchestrator, orchestratorFolder = true, project = "/src/app", model = "opus",
            effort = "high", sandbox = "workspace-write", prompt = "Go", workspace = "w1",
        )
        val input = templateInput("Round trip", form, codex)
        val t = SessionTemplate(
            id = "t", name = input.name, kind = input.kind, provider = input.provider, agent = input.agent, cwd = input.cwd,
            worktree = input.worktree, branchPattern = input.branchPattern, workspace = input.workspace, model = input.model,
            effort = input.effort, permissionMode = input.permissionMode, sandboxMode = input.sandboxMode, prompt = input.prompt,
        )
        val back = applyTemplate(NewSessionForm(), t, agents, now)
        assertEquals(createOpts(form, codex, isRepo = false), createOpts(back, agents[back.agentIndex], isRepo = false))
    }
}
