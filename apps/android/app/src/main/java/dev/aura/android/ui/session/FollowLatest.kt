package dev.aura.android.ui.session

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
import kotlinx.coroutines.launch

/**
 * Keeps a bottom-up transcript ([LazyListState] of a `reverseLayout` list,
 * item 0 the latest) at its latest entry while the user is there, and counts
 * what came while they read further up.
 */
@Stable
class FollowLatest internal constructor(private val list: LazyListState, private val scope: CoroutineScope) {
    /** The latest entry is in view. */
    val atLatest: Boolean by derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < NEAR_PX }

    /** Whether new entries scroll into view: the user was at the latest when they last stopped scrolling. */
    internal var pinned by mutableStateOf(true)

    private var seen by mutableIntStateOf(-1)
    private var count by mutableIntStateOf(0)

    /** Entries that came since the user scrolled away from the latest. */
    val unread: Int get() = if (seen < 0) 0 else (count - seen).coerceAtLeast(0)

    /** Back to the latest, and following it again. */
    fun jump() {
        pinned = true
        seen = count
        scope.launch { list.animateScrollToItem(0) }
    }

    /** Called with the transcript's size and latest entry on every change. */
    @Composable
    fun Track(count: Int, newestKey: Any?, newestLength: Int) {
        this.count = count
        LaunchedEffect(count, newestKey, newestLength) {
            // Never pulled away from under the user's finger.
            if (pinned && !list.isScrollInProgress) {
                seen = count
                if (list.firstVisibleItemIndex != 0 || list.firstVisibleItemScrollOffset != 0) list.scrollToItem(0)
            }
        }
    }

    internal fun settled() {
        pinned = atLatest
        if (pinned) seen = count
    }

    private companion object {
        /** Within this much of the bottom counts as at the latest. */
        const val NEAR_PX = 48
    }
}

@Composable
fun rememberFollowLatest(list: LazyListState): FollowLatest {
    val scope = rememberCoroutineScope()
    val follow = remember(list) { FollowLatest(list, scope) }
    LaunchedEffect(follow) {
        // Whether to follow is the user's: decided each time their scrolling ends.
        snapshotFlow { list.isScrollInProgress }.collect { scrolling -> if (!scrolling) follow.settled() }
    }
    return follow
}
