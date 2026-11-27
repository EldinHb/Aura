package dev.aura.android.ui.pairing

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.aura.android.R
import dev.aura.android.net.Fingerprint
import dev.aura.android.pairing.PairingLink
import dev.aura.android.ui.appViewModel
import dev.aura.android.ui.components.SnackbarMessages
import dev.aura.android.ui.theme.Spacing
import dev.aura.android.ui.theme.code
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddServerScreen(
    link: String?,
    onBack: () -> Unit,
    onPaired: (serverId: String) -> Unit,
) {
    val vm = appViewModel(key = "add:$link") { AddServerViewModel(it, link) }
    val step by vm.step.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    SnackbarMessages(vm.messages, snackbar)
    val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior()

    LaunchedEffect(step) {
        (step as? AddServerStep.Done)?.let { onPaired(it.serverId) }
    }
    BackHandler(enabled = step is AddServerStep.Confirm) { vm.back() }

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.add_server)) },
                navigationIcon = {
                    IconButton(onClick = { if (step is AddServerStep.Confirm) vm.back() else onBack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                scrollBehavior = scrollBehavior,
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        AnimatedContent(
            targetState = step,
            contentKey = { it::class },
            transitionSpec = { fadeIn(tween(220, delayMillis = 90)) togetherWith fadeOut(tween(90)) },
            modifier = Modifier.fillMaxSize().padding(padding).imePadding(),
            label = "add-server-step",
        ) { current ->
            Column(
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Column(
                    modifier = Modifier.widthIn(max = Spacing.contentMaxWidth).fillMaxWidth().padding(Spacing.m),
                    verticalArrangement = Arrangement.spacedBy(Spacing.m),
                ) {
                    when (current) {
                        AddServerStep.Enter -> EnterDetails(onLink = vm::useLink, onManual = vm::useManual)
                        is AddServerStep.Confirm -> ConfirmServer(current, onPair = vm::pair, onBack = vm::back)
                        is AddServerStep.Done -> {}
                    }
                }
            }
        }
    }
}

@Composable
private fun ColumnScope.EnterDetails(onLink: (String) -> Unit, onManual: (String, String, String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    var pasted by rememberSaveable { mutableStateOf("") }
    val scan = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let(onLink)
    }
    val scanPrompt = stringResource(R.string.scan_prompt)

    Text(stringResource(R.string.add_server_intro), style = MaterialTheme.typography.bodyLarge)
    Button(
        onClick = {
            scan.launch(
                ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt(scanPrompt)
                    .setBeepEnabled(false)
                    .setOrientationLocked(false),
            )
        },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Icon(Icons.Outlined.QrCodeScanner, contentDescription = null)
        Text(stringResource(R.string.scan_qr), modifier = Modifier.padding(start = Spacing.s))
    }

    SectionTitle(stringResource(R.string.paste_link_title))
    OutlinedTextField(
        value = pasted,
        onValueChange = { pasted = it },
        label = { Text(stringResource(R.string.pairing_link)) },
        placeholder = { Text("aura://pair?…") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        trailingIcon = {
            IconButton(onClick = {
                scope.launch {
                    clipboard.getClipEntry()?.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.let { pasted = it.toString() }
                }
            }) {
                Icon(Icons.Outlined.ContentPaste, contentDescription = stringResource(R.string.paste))
            }
        },
        modifier = Modifier.fillMaxWidth(),
    )
    FilledTonalButton(onClick = { onLink(pasted) }, enabled = pasted.isNotBlank(), modifier = Modifier.align(Alignment.End)) {
        Text(stringResource(R.string.continue_label))
    }

    HorizontalDivider()
    SectionTitle(stringResource(R.string.manual_title))
    var host by rememberSaveable { mutableStateOf("") }
    var port by rememberSaveable { mutableStateOf("") }
    var fingerprint by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    OutlinedTextField(
        value = host, onValueChange = { host = it }, singleLine = true,
        label = { Text(stringResource(R.string.host)) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = port, onValueChange = { port = it.filter(Char::isDigit) }, singleLine = true,
        label = { Text(stringResource(R.string.port)) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = fingerprint, onValueChange = { fingerprint = it },
        label = { Text(stringResource(R.string.fingerprint)) },
        supportingText = { Text(stringResource(R.string.fingerprint_help)) },
        textStyle = MaterialTheme.typography.code,
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = code, onValueChange = { code = it }, singleLine = true,
        label = { Text(stringResource(R.string.pairing_code)) },
        modifier = Modifier.fillMaxWidth(),
    )
    FilledTonalButton(
        onClick = { onManual(host, port, fingerprint, code) },
        enabled = host.isNotBlank() && port.isNotBlank() && fingerprint.isNotBlank() && code.isNotBlank(),
        modifier = Modifier.align(Alignment.End),
    ) {
        Text(stringResource(R.string.continue_label))
    }
}

@Composable
private fun ColumnScope.ConfirmServer(step: AddServerStep.Confirm, onPair: () -> Unit, onBack: () -> Unit) {
    val link: PairingLink = step.link
    Text(stringResource(R.string.confirm_title), style = MaterialTheme.typography.headlineSmall)
    Text(stringResource(R.string.confirm_body), style = MaterialTheme.typography.bodyLarge)
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Icon(Icons.Outlined.VerifiedUser, contentDescription = null)
                Text(link.name ?: link.host, style = MaterialTheme.typography.titleMedium)
            }
            Detail(
                stringResource(if (link.alternates.isEmpty()) R.string.address else R.string.addresses),
                link.hosts.joinToString("\n") { if (':' in it) "[$it]:${link.port}" else "$it:${link.port}" },
            )
            Detail(stringResource(R.string.fingerprint), Fingerprint.grouped(link.fingerprint), mono = true)
        }
    }
    if (step.pairing) LinearProgressIndicator(Modifier.fillMaxWidth())
    Row(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
        OutlinedButton(onClick = onBack, enabled = !step.pairing) { Text(stringResource(R.string.back)) }
        Button(onClick = onPair, enabled = !step.pairing) { Text(stringResource(R.string.pair)) }
    }
}

@Composable
private fun Detail(label: String, value: String, mono: Boolean = false) {
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer)
        Text(value, style = if (mono) MaterialTheme.typography.code else MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
}
