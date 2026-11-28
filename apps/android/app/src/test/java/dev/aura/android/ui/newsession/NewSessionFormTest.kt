package dev.aura.android.ui.newsession

import dev.aura.android.protocol.Autonomy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

class NewSessionFormTest {
    private val claude = AgentChoice("claude", null, "Claude Code")

    @Test
    fun `an agent session sends the folder, prompt and options, leaving defaults to the server`() {
        val opts = createOpts(
            NewSessionForm(project = "/p/app", prompt = " Fix it ", title = "Fix", model = "opus", permission = "plan", systemPrompt = "Be brief."),
            claude,
            isRepo = false,
        )
        assertEquals("/p/app", opts.cwd)
        assertEquals("Fix it", opts.initialPrompt)
        assertEquals("opus", opts.model)
        assertNull(opts.effort)
        assertNull(opts.sandboxMode)
        assertEquals("plan", opts.permissionMode)
        assertFalse(opts.orchestrator)
        assertNull(opts.worktree)
    }

    @Test
    fun `an orchestrator has no folder unless given one`() {
        val none = createOpts(NewSessionForm(kind = SessionKind.Orchestrator, project = "/p/app"), claude, isRepo = true)
        assertEquals("", none.cwd)
        assertTrue(none.orchestrator)
        val given = createOpts(NewSessionForm(kind = SessionKind.Orchestrator, project = "/p/app", orchestratorFolder = true), claude, isRepo = true)
        assertEquals("/p/app", given.cwd)
    }

    @Test
    fun `a feature owner starts on its goal, with its own autonomy when set`() {
        val opts = createOpts(
            NewSessionForm(kind = SessionKind.FeatureOwner, goal = "Ship the app", prompt = "ignored", autonomy = Autonomy.DEFAULT),
            claude,
            isRepo = false,
        )
        assertTrue(opts.featureOwner)
        assertTrue(opts.orchestrator)
        assertEquals("Ship the app", opts.featureGoal)
        assertEquals("Ship the app", opts.initialPrompt)
        assertEquals(Autonomy.DEFAULT, opts.autonomy)
    }

    @Test
    fun `a worktree is only asked for in a repository with a branch`() {
        val form = NewSessionForm(project = "/p/app", worktree = true, branch = "aura/fix")
        assertEquals("aura/fix", createOpts(form, claude, isRepo = true).worktree?.branch)
        assertNull(createOpts(form, claude, isRepo = false).worktree)
        assertNull(createOpts(form.copy(branch = " "), claude, isRepo = true).worktree)
    }

    @Test
    fun `the default branch follows the title, or the time without one`() {
        assertEquals("aura/fix-the-flaky-test", defaultBranch("Fix the flaky test!"))
        assertEquals("aura/202611281230", defaultBranch("", LocalDateTime.of(2026, 11, 28, 12, 30)))
    }
}
