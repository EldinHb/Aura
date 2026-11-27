//! A Windows command line from arguments, as `CommandLineToArgvW` (and the
//! C runtime every Windows program parses its arguments with) reads it back:
//! what `ShellExecuteExW` needs, since it takes one string, not a list.
//! The rules: an argument with a space, tab or quote (or an empty one) is
//! quoted; inside quotes a `"` is written `\"`, and backslashes are doubled
//! only where a quote follows them.

use std::ffi::{OsStr, OsString};

/// One argument, quoted when it needs to be.
pub fn arg(arg: &OsStr) -> String {
    let s = arg.to_string_lossy();
    if !s.is_empty() && !s.contains([' ', '\t', '\n', '\u{b}', '"']) {
        return s.into_owned();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in s.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                // The backslashes before a quote, doubled, then the quote escaped.
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            c => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    // Before the closing quote, backslashes are doubled too.
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// The arguments as one command line.
pub fn join(args: &[OsString]) -> OsString {
    args.iter()
        .map(|a| arg(a))
        .collect::<Vec<_>>()
        .join(" ")
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `CommandLineToArgvW`'s reading of the arguments after the program
    /// name (the documented rules, for checking on any host).
    fn parse(line: &str) -> Vec<String> {
        let mut args = Vec::new();
        let mut cur = String::new();
        let mut in_quotes = false;
        let mut have = false;
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '\\' {
                let start = i;
                while i < chars.len() && chars[i] == '\\' {
                    i += 1;
                }
                let n = i - start;
                if i < chars.len() && chars[i] == '"' {
                    cur.extend(std::iter::repeat_n('\\', n / 2));
                    if n % 2 == 1 {
                        cur.push('"');
                        i += 1;
                    }
                } else {
                    cur.extend(std::iter::repeat_n('\\', n));
                }
                have = true;
                continue;
            }
            if c == '"' {
                if in_quotes && i + 1 < chars.len() && chars[i + 1] == '"' {
                    cur.push('"');
                    i += 2;
                    continue;
                }
                in_quotes = !in_quotes;
                have = true;
            } else if (c == ' ' || c == '\t') && !in_quotes {
                if have {
                    args.push(std::mem::take(&mut cur));
                    have = false;
                }
            } else {
                cur.push(c);
                have = true;
            }
            i += 1;
        }
        if have {
            args.push(cur);
        }
        args
    }

    fn round_trip(args: &[&str]) {
        let os: Vec<OsString> = args.iter().map(OsString::from).collect();
        let line = join(&os).into_string().unwrap();
        assert_eq!(parse(&line), args, "line: {line}");
    }

    #[test]
    fn msiexec_with_a_path_with_spaces() {
        let line = join(&[
            "/i".into(),
            r"C:\Users\Eldin Habibovic\AppData\Local\Temp\aura-update-0.5.0-12\Aura.msi".into(),
            "/passive".into(),
        ]);
        assert_eq!(
            line,
            r#"/i "C:\Users\Eldin Habibovic\AppData\Local\Temp\aura-update-0.5.0-12\Aura.msi" /passive"#
        );
    }

    #[test]
    fn plain_arguments_stay_as_they_are() {
        assert_eq!(join(&["/P".into(), "/UPDATE".into()]), "/P /UPDATE");
        assert_eq!(
            arg(OsStr::new(r"C:\no\spaces\x.exe")),
            r"C:\no\spaces\x.exe"
        );
    }

    #[test]
    fn round_trips_what_windows_reads_back() {
        round_trip(&[r"C:\Program Files\Aura\Aura.msi", "/passive"]);
        round_trip(&[""]);
        round_trip(&[r#"say "hi""#]);
        round_trip(&[r"C:\dir with space\"]);
        round_trip(&[r#"a\"b"#, r"trailing\\", r"x\\\y"]);
        round_trip(&["it's", "tab\there", "two  spaces"]);
    }
}
