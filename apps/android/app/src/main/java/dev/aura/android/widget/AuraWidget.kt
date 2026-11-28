package dev.aura.android.widget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.aura.android.AuraApplication
import dev.aura.android.MainActivity
import dev.aura.android.R

/**
 * The home-screen widget: how many things wait on the user across the
 * servers, and the first few; tap one to open it, or the rest for the inbox.
 * Material You: the launcher's (wallpaper) colors through GlanceTheme.
 */
class AuraWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snapshot = (context.applicationContext as AuraApplication).container.waiting.current()
        provideContent {
            GlanceTheme { Content(context, snapshot) }
        }
    }

    @Composable
    private fun Content(context: Context, s: WaitingSnapshot) {
        val colors = GlanceTheme.colors
        Column(
            GlanceModifier
                .fillMaxSize()
                .background(colors.widgetBackground)
                .cornerRadius(CORNER)
                .padding(PADDING)
                .clickable(actionStartActivity(inboxIntent(context))),
        ) {
            Text(
                if (s.count == 0) {
                    context.getString(R.string.widget_nothing)
                } else {
                    context.resources.getQuantityString(R.plurals.widget_count, s.count, s.count)
                },
                style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Medium),
            )
            // A list, so a small widget scrolls rather than cutting items off.
            LazyColumn(GlanceModifier.fillMaxSize()) {
                items(s.items, itemId = { (it.serverId + "/" + it.sessionId + "/" + it.title).hashCode().toLong() }) { item ->
                    Column(GlanceModifier.fillMaxWidth().padding(top = ITEM_GAP)) {
                        Column(
                            GlanceModifier
                                .fillMaxWidth()
                                .background(colors.secondaryContainer)
                                .cornerRadius(ITEM_CORNER)
                                .padding(ITEM_PADDING)
                                .clickable(actionStartActivity(itemIntent(context, item))),
                        ) {
                            Text(
                                item.title.ifBlank { context.getString(R.string.untitled_session) },
                                maxLines = 2,
                                style = TextStyle(color = colors.onSecondaryContainer, fontWeight = FontWeight.Medium),
                            )
                            Text(item.detail, maxLines = 1, style = TextStyle(color = colors.onSecondaryContainer))
                        }
                    }
                }
                if (s.count > s.items.size) {
                    item {
                        Row(
                            GlanceModifier.fillMaxWidth().padding(top = ITEM_GAP).clickable(actionStartActivity(inboxIntent(context))),
                            horizontalAlignment = Alignment.End,
                        ) {
                            Text(context.resources.getQuantityString(R.plurals.widget_more, s.count - s.items.size, s.count - s.items.size), style = TextStyle(color = colors.primary))
                        }
                    }
                }
            }
        }
    }

    private companion object {
        val PADDING = 12.dp
        val CORNER = 24.dp
        val ITEM_CORNER = 12.dp
        val ITEM_PADDING = 8.dp
        val ITEM_GAP = 6.dp
    }
}

class AuraWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = AuraWidget()
}

/** Opens the inbox. */
fun inboxIntent(context: Context): Intent =
    Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_INBOX).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

/** Opens [item]'s session (its leader, on its tab). */
private fun itemIntent(context: Context, item: WaitingItem): Intent =
    Intent(context, MainActivity::class.java)
        .setAction(MainActivity.ACTION_OPEN_SESSION)
        .putExtra(MainActivity.EXTRA_SERVER, item.serverId)
        .putExtra(MainActivity.EXTRA_SESSION, item.sessionId)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
