package dev.aura.android.protocol

/**
 * Where a session stands for the user, which sorts the session list (the
 * desktop's `categoryOf`):
 * - [NeedsYou]: a question or approval is open, or its work finished (or
 *   failed) and the user has not looked since;
 * - [Working]: its agent is busy;
 * - [Idle]: nothing is going on and nothing is new.
 */
enum class Category { NeedsYou, Working, Idle }

val Session.category: Category
    get() = when {
        pendingCount > 0 || status == "waiting_approval" || status == "waiting_input" || attention != null -> Category.NeedsYou
        status == "running" -> Category.Working
        else -> Category.Idle
    }

/** Whether the session waits on the user: finished or failed is news, not waiting. */
val Session.waitsOnUser: Boolean
    get() = pendingCount > 0 || status == "waiting_approval" || status == "waiting_input" || attention == "waiting"

/**
 * Who works under whom, as the desktop's sidebar has it (`forestOf`): the
 * `orchestrator_id` chain, where a session whose orchestrator is gone leads,
 * and a cycle is broken at its oldest session.
 */
class Forest(sessions: List<Session>) {
    private val byId = sessions.associateBy { it.id }
    private val parent: Map<String, Session?>
    private val children: Map<String, List<Session>>

    init {
        val older = compareBy<Session>({ it.createdAt }, { it.id })
        fun raw(s: Session): Session? = s.orchestratorId?.takeIf { it != s.id }?.let(byId::get)
        val cut = HashSet<String>()
        val state = HashMap<String, Int>()
        for (s in sessions) {
            val path = mutableListOf<Session>()
            var cur: Session? = s
            while (cur != null && cur.id !in state) {
                state[cur.id] = 1
                path += cur
                cur = raw(cur)
            }
            if (cur != null && state[cur.id] == 1) cut += path.subList(path.indexOf(cur), path.size).minWith(older).id
            path.forEach { state[it.id] = 2 }
        }
        parent = sessions.associate { s -> s.id to if (s.id in cut) null else raw(s) }
        children = sessions.filter { parent[it.id] != null }.groupBy { parent.getValue(it.id)!!.id }.mapValues { (_, list) -> list.sortedWith(older) }
    }

    fun parentOf(id: String): Session? = parent[id]

    fun childrenOf(id: String): List<Session> = children[id].orEmpty()

    /** Every session under [id], depth first, oldest first at each level. */
    fun descendantsOf(id: String): List<Session> = childrenOf(id).flatMap { listOf(it) + descendantsOf(it.id) }

    /** [descendantsOf] without archived sessions; a live worker under an archived one is kept. */
    fun liveDescendantsOf(id: String): List<Session> = descendantsOf(id).filterNot { it.archived }

    fun leaderOf(s: Session): Session = generateSequence(s) { parentOf(it.id) }.last()

    /** The scheduled task [s] is a run of, or a worker of a run of. */
    fun scheduledTaskOf(s: Session): String? =
        s.scheduledTaskId ?: s.scheduledRun ?: parentOf(s.id)?.let(::scheduledTaskOf)

    /** The state a leader's row is sectioned by, for its whole tree (the desktop's `rollupOf`). */
    fun rollupOf(leader: Session): Category {
        val tree = liveDescendantsOf(leader.id)
        return when {
            leader.category == Category.NeedsYou || tree.any { it.waitsOnUser } -> Category.NeedsYou
            leader.status == "running" || tree.any { it.status == "running" } -> Category.Working
            else -> Category.Idle
        }
    }
}
