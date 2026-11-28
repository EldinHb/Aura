package dev.aura.android.ui.usage

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.protocol.Event
import dev.aura.android.protocol.SessionUsage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.coroutines.cancellation.CancellationException

/**
 * One session's usage (`usage.session`), turn by turn, kept fresh: loaded
 * again after each of its turns and after a reconnect. With [includeWorkers],
 * its workers' too (a turn of a worker refreshes it as well).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionUsageViewModel(
    private val container: AppContainer,
    private val serverId: String,
    private val sessionId: String,
    private val includeWorkers: Boolean,
) : ViewModel() {
    private val _usage = MutableStateFlow<SessionUsage?>(null)

    /** Null until loaded, and when the server has no usage for it (or is too old to know usage). */
    val usage: StateFlow<SessionUsage?> = _usage

    private val _failed = MutableStateFlow<String?>(null)

    /** Why the last load failed, if it did. */
    val failed: StateFlow<String?> = _failed

    private var job: Job? = null

    init {
        viewModelScope.launch {
            container.connections.map { it[serverId] }.flatMapLatest { c ->
                if (c == null) {
                    flowOf()
                } else {
                    merge(
                        c.resyncs.map { },
                        c.events.map { live ->
                            val e = live.event
                            if (e is Event.TurnCompleted && (e.sessionId == sessionId || (includeWorkers && e.sessionId in workerIds()))) Unit else null
                        },
                    )
                }
            }.collect { if (it != null) load() }
        }
        load()
    }

    private fun workerIds(): Set<String> {
        val sessions = container.connection(serverId)?.sessions?.value.orEmpty()
        val ids = mutableSetOf<String>()
        var frontier = setOf(sessionId)
        while (frontier.isNotEmpty()) {
            frontier = sessions.filter { it.orchestratorId in frontier && it.id !in ids }.map { it.id }.toSet()
            ids += frontier
        }
        return ids
    }

    fun load() {
        val c = container.connection(serverId) ?: return
        job?.cancel()
        job = viewModelScope.launch {
            try {
                _usage.value = c.call("usage.session", buildJsonObject {
                    put("id", JsonPrimitive(sessionId))
                    put("includeWorkers", JsonPrimitive(includeWorkers))
                }, SessionUsage.serializer())
                _failed.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _failed.value = e.message ?: e.javaClass.simpleName
            }
        }
    }
}
