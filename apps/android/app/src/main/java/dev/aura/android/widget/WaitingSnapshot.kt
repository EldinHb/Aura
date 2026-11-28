package dev.aura.android.widget

import dev.aura.android.protocol.folderName
import dev.aura.android.protocol.projectPath
import dev.aura.android.ui.inbox.Inbox
import kotlinx.serialization.Serializable

/** One thing waiting on the user, as the widget and the tile show it. */
@Serializable
data class WaitingItem(val serverId: String, val sessionId: String, val title: String, val detail: String)

/**
 * What waits on the user across the servers, saved as it changes so the
 * home-screen widget and the Quick Settings tile show it even when the app
 * is not running: how many, and the first few.
 */
@Serializable
data class WaitingSnapshot(val count: Int = 0, val items: List<WaitingItem> = emptyList()) {
    companion object {
        /** How many items the widget lists. */
        const val SHOWN = 3

        fun of(inbox: Inbox): WaitingSnapshot {
            val questions = inbox.questions.map {
                WaitingItem(it.serverId, it.feature.ownerId, it.question.question, it.serverName + " · " + it.feature.goal)
            }
            val sessions = inbox.sessions.map {
                WaitingItem(it.serverId, it.session.id, it.session.title, it.serverName + " · " + folderName(it.session.projectPath))
            }
            return WaitingSnapshot(inbox.size, (questions + sessions).take(SHOWN))
        }
    }
}
