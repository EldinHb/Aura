package dev.aura.android.ui.session

import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/** A list state that opens at the end of its items: the latest of a transcript, with no jump to get there. */
fun latestListState(): LazyListState = LazyListState(END_INDEX, END_OFFSET)

/** Past the end, which the list clamps to its last item's bottom. */
private const val END_INDEX = 1_000_000
private const val END_OFFSET = 1_000_000

/**
 * Keeps a transcript (top to bottom, the latest last) at its end while the
 * user is there, and counts what came while they read further up.
 *
 * A top-down list keeps what is on screen where it is when items below it
 * grow, so reading further up while a reply streams in, nothing moves. At the
 * end, it follows the list's own layout: whenever a reply or a new entry
 * leaves the bottom out of view, the end is asked for again, applied in the
 * next layout without animation, so the bottom stays anchored. It never moves
 * the list while the user scrolls, and stops following when they leave the end.
 */
@Stable
class FollowLatest internal constructor(private val list: LazyListState, private val scope: CoroutineScope) {
    /** The end of the transcript is in view. */
    val atLatest: Boolean by derivedStateOf { atEnd(list.layoutInfo) }

    /** Whether the end is followed: the user was at it when they last stopped scrolling. */
    internal var pinned by mutableStateOf(true)

    private var seen by mutableIntStateOf(-1)
    private var count by mutableIntStateOf(0)

    /** Entries that came since the user scrolled away from the latest. */
    val unread: Int get() = if (seen < 0) 0 else (count - seen).coerceAtLeast(0)

    /** Back to the latest, and following it again. */
    fun jump() {
        pinned = true
        seen = count
        scope.launch { list.scrollToItem(lastIndex(), END_OFFSET) }
    }

    private fun lastIndex() = (list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)

    /** Called with the transcript's number of entries on every change. */
    @Composable
    fun Track(count: Int) {
        this.count = count
        LaunchedEffect(count) { if (pinned) seen = count }
    }

    internal suspend fun follow() {
        // Strictly at the end, not just near it: the last line is never left under the composer.
        snapshotFlow { pinned && !list.isScrollInProgress && list.canScrollForward }
            .distinctUntilChanged()
            .collect { behind -> if (behind) list.requestScrollToItem(lastIndex(), END_OFFSET) }
    }

    internal fun settled() {
        pinned = atLatest
        if (pinned) seen = count
    }

    internal companion object {
        /** Within this much of the bottom counts as at the latest. */
        const val NEAR_PX = 48

        /** Whether [info] shows the end of the list (or the list is empty). */
        fun atEnd(info: LazyListLayoutInfo): Boolean {
            val last = info.visibleItemsInfo.lastOrNull() ?: return true
            return last.index == info.totalItemsCount - 1 && last.offset + last.size <= info.viewportEndOffset + NEAR_PX
        }
    }
}

@Composable
fun rememberFollowLatest(list: LazyListState): FollowLatest {
    val scope = rememberCoroutineScope()
    val follow = remember(list) { FollowLatest(list, scope) }
    LaunchedEffect(follow) {
        // Whether to follow is the user's: decided each time their scrolling ends.
        launch { snapshotFlow { list.isScrollInProgress }.collect { scrolling -> if (!scrolling) follow.settled() } }
        follow.follow()
    }
    return follow
}
