package dev.aura.android.ui.newsession

import dev.aura.android.protocol.SessionTemplate
import dev.aura.android.protocol.TemplateInput
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/** The branch a template names when it has no pattern of its own (as the daemon documents it). */
const val DEFAULT_BRANCH_PATTERN = "aura/{slug}-{date}"

/** Lower case with hyphens, at most 40 characters: a title as part of a branch name. */
fun slug(text: String): String = text.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(40).trimEnd('-')

/** [pattern] with `{slug}` ([title], else [fallback]), `{date}` (yyyyMMdd) and `{time}` (HHmm) filled in. */
fun expandBranch(pattern: String, title: String, fallback: String, now: LocalDateTime = LocalDateTime.now()): String {
    val s = slug(title).ifEmpty { slug(fallback) }.ifEmpty { "session" }
    return pattern
        .replace("{slug}", s)
        .replace("{date}", now.format(DateTimeFormatter.ofPattern("yyyyMMdd")))
        .replace("{time}", now.format(DateTimeFormatter.ofPattern("HHmm")))
        .replace(' ', '-')
}

fun SessionKind.wire(): String = when (this) {
    SessionKind.Agent -> "agent"
    SessionKind.Orchestrator -> "orchestrator"
    SessionKind.FeatureOwner -> "feature_owner"
}

fun sessionKind(wire: String): SessionKind = when (wire) {
    "orchestrator" -> SessionKind.Orchestrator
    "feature_owner" -> SessionKind.FeatureOwner
    else -> SessionKind.Agent
}

/**
 * The form [template] fills in, over [form]: every option the template sets,
 * the rest as the form had it. The agent is the one of [agents] the template
 * names (the first when it is not there); the title stays the user's.
 */
fun applyTemplate(form: NewSessionForm, template: SessionTemplate, agents: List<AgentChoice>, now: LocalDateTime = LocalDateTime.now()): NewSessionForm {
    val kind = sessionKind(template.kind)
    val agentIndex = agents.indexOfFirst { it.provider == template.provider && it.agent == template.agent }.coerceAtLeast(0)
    val owns = kind == SessionKind.FeatureOwner
    val prompt = template.prompt.orEmpty()
    return form.copy(
        kind = kind,
        agentIndex = agentIndex,
        project = template.cwd ?: form.project,
        // An orchestrator's template without a folder starts it without one.
        orchestratorFolder = template.cwd != null,
        group = template.group.orEmpty(),
        model = template.model.orEmpty(),
        effort = template.effort.orEmpty(),
        permission = template.permissionMode.orEmpty(),
        sandbox = template.sandboxMode.orEmpty(),
        worktree = template.worktree,
        branch = if (template.worktree) expandBranch(template.branchPattern ?: DEFAULT_BRANCH_PATTERN, form.title, template.name, now) else "",
        // Until the user edits it, the branch follows the title, after the template's pattern.
        branchTouched = false,
        branchPattern = if (template.worktree) template.branchPattern ?: DEFAULT_BRANCH_PATTERN else null,
        templateName = template.name,
        prompt = if (owns) form.prompt else prompt,
        goal = if (owns) prompt else form.goal,
        systemPrompt = template.systemPrompt.orEmpty(),
        autonomy = if (owns) template.autonomy else null,
        workspace = template.workspace ?: form.workspace,
    )
}

/** [form] as a template named [name]: what `template.create` takes. */
fun templateInput(name: String, form: NewSessionForm, agent: AgentChoice): TemplateInput {
    val owns = form.kind == SessionKind.FeatureOwner
    val cwd = if (form.noFolder) null else form.project.trim().ifEmpty { null }
    val worktree = cwd != null && form.worktree
    return TemplateInput(
        name = name.trim(),
        kind = form.kind.wire(),
        provider = agent.provider,
        agent = agent.agent,
        cwd = cwd,
        worktree = worktree,
        // A branch the user typed is kept as it is; one that followed the title keeps following it.
        branchPattern = when {
            !worktree -> null
            form.branchTouched && form.branch.isNotBlank() -> form.branch.trim()
            else -> form.branchPattern
        },
        workspace = form.workspace,
        group = form.group.trim().ifEmpty { null },
        model = form.model.ifEmpty { null },
        effort = form.effort.ifEmpty { null },
        permissionMode = form.permission.ifEmpty { null },
        sandboxMode = form.sandbox.ifEmpty { null },
        autonomy = if (owns) form.autonomy else null,
        systemPrompt = form.systemPrompt.takeIf { it.isNotBlank() },
        prompt = (if (owns) form.goal else form.prompt).trim().ifEmpty { null },
    )
}
