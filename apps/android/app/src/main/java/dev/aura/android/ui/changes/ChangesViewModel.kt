package dev.aura.android.ui.changes

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aura.android.AppContainer
import dev.aura.android.diff.DiffFile
import dev.aura.android.diff.parseUnifiedDiff
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.coroutines.cancellation.CancellationException

/** What the Changes screen shows: loading, the files, or why it could not load. */
sealed interface ChangesState {
    data object Loading : ChangesState
    data class Loaded(val files: List<DiffFile>) : ChangesState
    data class Failed(val message: String) : ChangesState
}

/** A session's changes, read from the server (`session.git_diff`, its own folder only). */
class ChangesViewModel(private val container: AppContainer, private val serverId: String, private val sessionId: String) : ViewModel() {
    private val _state = MutableStateFlow<ChangesState>(ChangesState.Loading)
    val state: StateFlow<ChangesState> = _state

    init {
        load()
    }

    fun load() {
        val c = container.connection(serverId) ?: return
        _state.value = ChangesState.Loading
        viewModelScope.launch {
            _state.value = try {
                val text = c.call("session.git_diff", buildJsonObject { put("id", JsonPrimitive(sessionId)) }).jsonPrimitive.contentOrNull.orEmpty()
                ChangesState.Loaded(withContext(Dispatchers.Default) { parseUnifiedDiff(text) })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                ChangesState.Failed(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    /** Puts [text] in the session's composer, for when the user is back there. */
    fun askForChanges(text: String) {
        container.composerPrefill.value = container.composerPrefill.value + ("$serverId/$sessionId" to text)
    }
}
