package dev.aura.android.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.core.app.RemoteInput
import dev.aura.android.AuraApplication
import dev.aura.android.R
import dev.aura.android.net.ProtocolJson
import dev.aura.android.protocol.ApprovalDecision
import dev.aura.android.protocol.Input
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** Acts on a notification's buttons: a reply to a main chat, or an approval's answer. */
class NotificationActions : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val container = (context.applicationContext as AuraApplication).container
        val serverId = intent.getStringExtra(EXTRA_SERVER) ?: return
        val sessionId = intent.getStringExtra(EXTRA_SESSION) ?: return
        val key = intent.getStringExtra(EXTRA_KEY) ?: return
        val (method, params) = when (intent.action) {
            REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(EXTRA_REPLY)?.toString()?.trim()
                if (text.isNullOrEmpty()) return
                "session.send" to buildJsonObject {
                    put("id", JsonPrimitive(sessionId))
                    put("input", ProtocolJson.encodeToJsonElement(Input.serializer(), Input(text = text)))
                }
            }
            APPROVE, DECLINE -> "session.respond_approval" to buildJsonObject {
                put("id", JsonPrimitive(sessionId))
                put("approval_id", JsonPrimitive(intent.getStringExtra(EXTRA_APPROVAL) ?: return))
                put(
                    "decision",
                    ProtocolJson.encodeToJsonElement(ApprovalDecision.serializer(), ApprovalDecision(if (intent.action == APPROVE) "accept" else "decline")),
                )
            }
            else -> return
        }
        val done = goAsync()
        container.scope.launch {
            try {
                val connection = container.connection(serverId) ?: error(context.getString(R.string.conn_offline))
                connection.call(method, params)
                container.notifier.dismiss(serverId, key)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(context, context.getString(R.string.action_failed, e.message ?: ""), Toast.LENGTH_LONG).show()
                }
            } finally {
                done.finish()
            }
        }
    }

    companion object {
        const val REPLY = "dev.aura.android.action.REPLY"
        const val APPROVE = "dev.aura.android.action.APPROVE"
        const val DECLINE = "dev.aura.android.action.DECLINE"
        const val EXTRA_REPLY = "reply"
        const val EXTRA_SERVER = "server"
        const val EXTRA_SESSION = "session"
        const val EXTRA_KEY = "key"
        const val EXTRA_APPROVAL = "approval"

        fun intent(context: Context, action: String, serverId: String, sessionId: String, key: String): Intent =
            Intent(context, NotificationActions::class.java)
                .setAction(action)
                .putExtra(EXTRA_SERVER, serverId)
                .putExtra(EXTRA_SESSION, sessionId)
                .putExtra(EXTRA_KEY, key)
    }
}
