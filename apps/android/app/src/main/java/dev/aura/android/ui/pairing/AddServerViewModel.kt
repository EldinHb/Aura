package dev.aura.android.ui.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.R
import dev.aura.android.data.SavedServer
import dev.aura.android.net.HandshakeRejectedException
import dev.aura.android.net.RemoteErrors
import dev.aura.android.net.RpcException
import dev.aura.android.net.fingerprintMismatch
import dev.aura.android.net.pair
import dev.aura.android.pairing.PairingLink
import dev.aura.android.ui.components.UiMessage
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException

/** Where adding a server stands. */
sealed interface AddServerStep {
    /** Choosing how to give the server's details. */
    data object Enter : AddServerStep

    /** The user checks the fingerprint before anything is sent. */
    data class Confirm(val link: PairingLink, val pairing: Boolean = false) : AddServerStep

    /** Paired and saved, as [serverId]. */
    data class Done(val serverId: String) : AddServerStep
}

class AddServerViewModel(private val container: AppContainer, initialLink: String?) : ViewModel() {
    private val _step = MutableStateFlow<AddServerStep>(AddServerStep.Enter)
    val step: StateFlow<AddServerStep> = _step

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages = _messages.receiveAsFlow()

    init {
        initialLink?.let(::useLink)
    }

    /** Takes a pairing link (scanned, pasted, or opened); says why when it is not one. */
    fun useLink(text: String) {
        PairingLink.parse(text)
            .onSuccess { _step.value = AddServerStep.Confirm(it) }
            .onFailure { _messages.trySend(UiMessage.Text(it.message ?: "")) }
    }

    fun useManual(host: String, port: String, fingerprint: String, code: String) {
        PairingLink.of(host, port, fingerprint, code)
            .onSuccess { _step.value = AddServerStep.Confirm(it) }
            .onFailure { _messages.trySend(UiMessage.Text(it.message ?: "")) }
    }

    fun back() {
        _step.value = AddServerStep.Enter
    }

    /** Pairs with the server the user confirmed, and saves it. */
    fun pair() {
        val confirm = _step.value as? AddServerStep.Confirm ?: return
        if (confirm.pairing) return
        _step.value = confirm.copy(pairing = true)
        viewModelScope.launch {
            val link = confirm.link
            try {
                val result = pair(container.http, link, container.deviceName)
                val server = SavedServer(
                    id = UUID.randomUUID().toString(),
                    name = link.name ?: result.serverName,
                    host = link.host,
                    port = link.port,
                    fingerprint = link.fingerprint,
                    serverId = result.serverId,
                    deviceId = result.deviceId,
                    sealedToken = container.store.seal(result.token),
                )
                container.store.upsert(server)
                val saved = container.store.all().first { it.serverId == result.serverId }
                _step.value = AddServerStep.Done(saved.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _step.value = confirm.copy(pairing = false)
                _messages.trySend(describe(e))
            }
        }
    }

    private fun describe(e: Throwable): UiMessage {
        e.fingerprintMismatch()?.let { return UiMessage.Res(R.string.pair_cert_mismatch) }
        return when (e) {
            is RpcException -> when (e.code) {
                RemoteErrors.PAIR_CODE_INVALID -> UiMessage.Res(R.string.pair_code_invalid)
                RemoteErrors.RATE_LIMITED -> UiMessage.Plural(R.plurals.pair_rate_limited, (e.retryAfterSecs ?: 60).toInt())
                else -> UiMessage.Res(R.string.pair_refused, listOf(e.message ?: ""))
            }
            is HandshakeRejectedException -> UiMessage.Text(e.message ?: "")
            is java.net.UnknownHostException -> UiMessage.Res(R.string.pair_unknown_host)
            is java.net.ConnectException, is java.net.SocketTimeoutException -> UiMessage.Res(R.string.pair_unreachable)
            else -> UiMessage.Res(R.string.pair_failed, listOf(e.message ?: e.javaClass.simpleName))
        }
    }
}
