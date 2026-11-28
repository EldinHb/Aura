package dev.aura.android.ui.usage

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.R
import dev.aura.android.net.ServerConnection
import dev.aura.android.protocol.UsageSummary
import dev.aura.android.ui.components.UiMessage
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.coroutines.cancellation.CancellationException

/** The periods the usage screen offers: today, and the last 7 or 30 days, today included. */
enum class UsagePeriod(val days: Long) { Today(1), Week(7), Month(30) }

/** [from, to) of [period] in [zone], ending at the end of [today]. */
fun usageRange(period: UsagePeriod, today: LocalDate, zone: ZoneId): Pair<Instant, Instant> {
    val to = today.plusDays(1).atStartOfDay(zone).toInstant()
    val from = today.minusDays(period.days - 1).atStartOfDay(zone).toInstant()
    return from to to
}

/** The phone's offset from UTC in minutes, for which day a turn falls on. */
fun tzOffsetMinutes(zone: ZoneId, at: Instant = Instant.now()): Int = zone.rules.getOffset(at).totalSeconds / 60

/** What the usage screen shows for a period. */
data class UsageDashboard(
    val period: UsagePeriod,
    val days: UsageSummary,
    val sessions: UsageSummary,
    val features: UsageSummary,
    val models: UsageSummary,
)

/** `usage.summary` for [from, to), grouped by [groupBy]. */
suspend fun ServerConnection.usageSummary(from: Instant, to: Instant, groupBy: String, limit: Int? = null, zone: ZoneId = ZoneId.systemDefault()): UsageSummary =
    call("usage.summary", buildJsonObject {
        put("from", JsonPrimitive(from.toString()))
        put("to", JsonPrimitive(to.toString()))
        put("groupBy", JsonPrimitive(groupBy))
        put("tzOffsetMinutes", JsonPrimitive(tzOffsetMinutes(zone, from)))
        limit?.let { put("limit", JsonPrimitive(it)) }
    }, UsageSummary.serializer())

class UsageViewModel(private val container: AppContainer, private val serverId: String) : ViewModel() {
    private val _period = MutableStateFlow(UsagePeriod.Week)
    val period: StateFlow<UsagePeriod> = _period

    private val _dashboard = MutableStateFlow<UsageDashboard?>(null)

    /** The period's usage; null while loading. */
    val dashboard: StateFlow<UsageDashboard?> = _dashboard

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages = _messages.receiveAsFlow()

    private var job: Job? = null

    init {
        load()
    }

    fun select(period: UsagePeriod) {
        if (period == _period.value && _dashboard.value?.period == period) return
        _period.value = period
        load()
    }

    fun load() {
        val c = container.connection(serverId) ?: return
        val period = _period.value
        val zone = ZoneId.systemDefault()
        val (from, to) = usageRange(period, ZonedDateTime.now(zone).toLocalDate(), zone)
        job?.cancel()
        _loading.value = true
        job = viewModelScope.launch {
            try {
                _dashboard.value = coroutineScope {
                    val days = async { c.usageSummary(from, to, "day", zone = zone) }
                    val sessions = async { c.usageSummary(from, to, "session", limit = TOP) }
                    val features = async { c.usageSummary(from, to, "feature", limit = TOP_SMALL) }
                    val models = async { c.usageSummary(from, to, "model", limit = TOP_SMALL) }
                    UsageDashboard(period, days.await(), sessions.await(), features.await(), models.await())
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _messages.trySend(UiMessage.Res(R.string.load_failed, listOf(e.message ?: "")))
            } finally {
                _loading.value = false
            }
        }
    }

    private companion object {
        const val TOP = 8
        const val TOP_SMALL = 5
    }
}
