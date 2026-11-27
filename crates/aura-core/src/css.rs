//! A CSS tokenizer (CSS Syntax Level 3, §4), enough to judge theme files:
//! escapes are decoded the way a browser decodes them, so `u\72l(` is a
//! `url(` and `@im\70ort` an `@import`, and every resource-bearing construct
//! is seen as the browser will see it.

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Ident(String),
    /// `name(`, name decoded.
    Function(String),
    /// `@name`, name decoded.
    AtKeyword(String),
    Hash(String),
    Str(String),
    BadStr,
    /// An unquoted `url(…)`, its value decoded.
    Url(String),
    BadUrl,
    Delim(char),
    Number,
    Percentage,
    Dimension,
    Whitespace,
    Cdo,
    Cdc,
    Colon,
    Semicolon,
    Comma,
    LBracket,
    RBracket,
    LParen,
    RParen,
    LBrace,
    RBrace,
}

struct Lexer {
    c: Vec<char>,
    i: usize,
}

fn is_name_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || !c.is_ascii()
}

fn is_name(c: char) -> bool {
    is_name_start(c) || c.is_ascii_digit() || c == '-'
}

impl Lexer {
    fn peek(&self, n: usize) -> Option<char> {
        self.c.get(self.i + n).copied()
    }

    fn valid_escape_at(&self, n: usize) -> bool {
        self.peek(n) == Some('\\') && self.peek(n + 1) != Some('\n')
    }

    fn starts_ident_at(&self, n: usize) -> bool {
        match self.peek(n) {
            Some('-') => {
                matches!(self.peek(n + 1), Some(c) if is_name_start(c) || c == '-')
                    || self.valid_escape_at(n + 1)
            }
            Some('\\') => self.valid_escape_at(n),
            Some(c) => is_name_start(c),
            None => false,
        }
    }

    fn starts_number_at(&self, n: usize) -> bool {
        match self.peek(n) {
            Some('+' | '-') => {
                matches!(self.peek(n + 1), Some(c) if c.is_ascii_digit())
                    || (self.peek(n + 1) == Some('.')
                        && matches!(self.peek(n + 2), Some(c) if c.is_ascii_digit()))
            }
            Some('.') => matches!(self.peek(n + 1), Some(c) if c.is_ascii_digit()),
            Some(c) => c.is_ascii_digit(),
            None => false,
        }
    }

    /// After the backslash.
    fn escape(&mut self) -> char {
        let Some(c) = self.peek(0) else {
            return '\u{FFFD}';
        };
        if c.is_ascii_hexdigit() {
            let mut hex = String::new();
            while hex.len() < 6 && matches!(self.peek(0), Some(h) if h.is_ascii_hexdigit()) {
                hex.push(self.c[self.i]);
                self.i += 1;
            }
            if matches!(self.peek(0), Some(' ' | '\t' | '\n')) {
                self.i += 1;
            }
            let v = u32::from_str_radix(&hex, 16).unwrap_or(0);
            return match char::from_u32(v) {
                Some(ch) if v != 0 => ch,
                _ => '\u{FFFD}',
            };
        }
        self.i += 1;
        c
    }

    fn name(&mut self) -> String {
        let mut out = String::new();
        loop {
            match self.peek(0) {
                Some(c) if is_name(c) => {
                    out.push(c);
                    self.i += 1;
                }
                Some('\\') if self.valid_escape_at(0) => {
                    self.i += 1;
                    out.push(self.escape());
                }
                _ => return out,
            }
        }
    }

    fn number(&mut self) -> Tok {
        if matches!(self.peek(0), Some('+' | '-')) {
            self.i += 1;
        }
        while matches!(self.peek(0), Some(c) if c.is_ascii_digit()) {
            self.i += 1;
        }
        if self.peek(0) == Some('.') && matches!(self.peek(1), Some(c) if c.is_ascii_digit()) {
            self.i += 1;
            while matches!(self.peek(0), Some(c) if c.is_ascii_digit()) {
                self.i += 1;
            }
        }
        if matches!(self.peek(0), Some('e' | 'E')) {
            let sign = usize::from(matches!(self.peek(1), Some('+' | '-')));
            if matches!(self.peek(1 + sign), Some(c) if c.is_ascii_digit()) {
                self.i += 1 + sign;
                while matches!(self.peek(0), Some(c) if c.is_ascii_digit()) {
                    self.i += 1;
                }
            }
        }
        if self.starts_ident_at(0) {
            self.name();
            Tok::Dimension
        } else if self.peek(0) == Some('%') {
            self.i += 1;
            Tok::Percentage
        } else {
            Tok::Number
        }
    }

    fn string(&mut self, quote: char) -> Tok {
        let mut out = String::new();
        loop {
            match self.peek(0) {
                None => return Tok::Str(out),
                Some(c) if c == quote => {
                    self.i += 1;
                    return Tok::Str(out);
                }
                Some('\n') => return Tok::BadStr,
                Some('\\') => {
                    self.i += 1;
                    match self.peek(0) {
                        None => {}
                        Some('\n') => self.i += 1,
                        Some(_) => out.push(self.escape()),
                    }
                }
                Some(c) => {
                    out.push(c);
                    self.i += 1;
                }
            }
        }
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(0), Some(' ' | '\t' | '\n')) {
            self.i += 1;
        }
    }

    fn bad_url_rest(&mut self) {
        while let Some(c) = self.peek(0) {
            self.i += 1;
            if c == ')' {
                return;
            }
            if c == '\\' && self.peek(0).is_some() {
                self.i += 1;
            }
        }
    }

    fn url(&mut self) -> Tok {
        let mut out = String::new();
        self.skip_ws();
        loop {
            match self.peek(0) {
                None => return Tok::Url(out),
                Some(')') => {
                    self.i += 1;
                    return Tok::Url(out);
                }
                Some(' ' | '\t' | '\n') => {
                    self.skip_ws();
                    return match self.peek(0) {
                        None => Tok::Url(out),
                        Some(')') => {
                            self.i += 1;
                            Tok::Url(out)
                        }
                        _ => {
                            self.bad_url_rest();
                            Tok::BadUrl
                        }
                    };
                }
                Some('"' | '\'' | '(') => {
                    self.bad_url_rest();
                    return Tok::BadUrl;
                }
                Some(c) if (c as u32) < 0x20 || c == '\u{7f}' => {
                    self.bad_url_rest();
                    return Tok::BadUrl;
                }
                Some('\\') => {
                    if self.valid_escape_at(0) {
                        self.i += 1;
                        out.push(self.escape());
                    } else {
                        self.bad_url_rest();
                        return Tok::BadUrl;
                    }
                }
                Some(c) => {
                    out.push(c);
                    self.i += 1;
                }
            }
        }
    }

    fn ident_like(&mut self) -> Tok {
        let name = self.name();
        if self.peek(0) != Some('(') {
            return Tok::Ident(name);
        }
        self.i += 1;
        if name.eq_ignore_ascii_case("url") {
            let save = self.i;
            self.skip_ws();
            if matches!(self.peek(0), Some('"' | '\'')) {
                self.i = save;
                return Tok::Function(name);
            }
            self.i = save;
            return self.url();
        }
        Tok::Function(name)
    }

    fn next(&mut self) -> Option<Tok> {
        let c = self.peek(0)?;
        if c == '/' && self.peek(1) == Some('*') {
            self.i += 2;
            while self.peek(0).is_some()
                && !(self.peek(0) == Some('*') && self.peek(1) == Some('/'))
            {
                self.i += 1;
            }
            self.i = (self.i + 2).min(self.c.len());
            return self.next();
        }
        Some(match c {
            ' ' | '\t' | '\n' => {
                self.skip_ws();
                Tok::Whitespace
            }
            '"' | '\'' => {
                self.i += 1;
                self.string(c)
            }
            '#' if matches!(self.peek(1), Some(n) if is_name(n)) || self.valid_escape_at(1) => {
                self.i += 1;
                Tok::Hash(self.name())
            }
            '(' | ')' | '[' | ']' | '{' | '}' | ',' | ':' | ';' => {
                self.i += 1;
                match c {
                    '(' => Tok::LParen,
                    ')' => Tok::RParen,
                    '[' => Tok::LBracket,
                    ']' => Tok::RBracket,
                    '{' => Tok::LBrace,
                    '}' => Tok::RBrace,
                    ',' => Tok::Comma,
                    ':' => Tok::Colon,
                    _ => Tok::Semicolon,
                }
            }
            _ if self.starts_number_at(0) => self.number(),
            '-' if self.peek(1) == Some('-') && self.peek(2) == Some('>') => {
                self.i += 3;
                Tok::Cdc
            }
            '<' if self.peek(1) == Some('!')
                && self.peek(2) == Some('-')
                && self.peek(3) == Some('-') =>
            {
                self.i += 4;
                Tok::Cdo
            }
            '@' if self.starts_ident_at(1) => {
                self.i += 1;
                Tok::AtKeyword(self.name())
            }
            _ if self.starts_ident_at(0) => self.ident_like(),
            _ => {
                self.i += 1;
                Tok::Delim(c)
            }
        })
    }
}

/// The tokens of `css`, after the spec's preprocessing (newlines, NUL).
pub fn tokenize(css: &str) -> Vec<Tok> {
    let text = css
        .replace("\r\n", "\n")
        .replace(['\r', '\u{c}'], "\n")
        .replace('\0', "\u{FFFD}");
    let mut lx = Lexer {
        c: text.chars().collect(),
        i: 0,
    };
    let mut out = vec![];
    while let Some(t) = lx.next() {
        out.push(t);
    }
    out
}

/// Functions that take a URL or make an image (vendor prefixes stripped).
/// Their arguments may load something, so only literal `data:` URLs are allowed in them.
const URL_FUNCTIONS: &[&str] = &["url", "src", "image", "image-set", "cross-fade", "element"];

/// Generic font families, and so the families Aura's approval prompts use: a
/// theme's `@font-face` may not take any of these names.
const GENERIC_FAMILIES: &[&str] = &[
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong",
    "-apple-system",
    "blinkmacsystemfont",
];

fn unprefixed(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    for p in ["-webkit-", "-moz-", "-o-", "-ms-"] {
        if let Some(rest) = lower.strip_prefix(p) {
            return rest.to_string();
        }
    }
    lower
}

fn is_url_function(name: &str) -> bool {
    URL_FUNCTIONS.contains(&unprefixed(name).as_str())
}

fn is_data_url(v: &str) -> bool {
    v.trim().to_ascii_lowercase().starts_with("data:")
}

fn short(v: &str) -> String {
    let s: String = v.trim().chars().take(60).collect();
    if v.trim().chars().count() > 60 {
        format!("{s}…")
    } else {
        s
    }
}

const NOT_LOADED: &str =
    "only literal data: URLs are; Aura does not load files from the web or disk for a theme";

/// Why `css` (a theme's CSS file) would load something from outside, or use
/// a construct a theme may not use:
/// - `url()` and the strings in `src()`, `image()`, `image-set()`,
///   `cross-fade()` and `element()` (and vendor variants) must be literal
///   `data:` URLs, and nothing inside those functions may be another
///   function such as `var()` (whose value could be any URL);
/// - no `@import` and no `@layer`;
/// - no `local()` fonts, and no `@font-face` that takes a generic family
///   name (the families Aura's approval prompts are drawn in).
pub fn resource_problem(css: &str) -> Option<String> {
    let toks = tokenize(css);
    // The function each nesting level is inside (None for plain parentheses and blocks).
    let mut stack: Vec<Option<String>> = vec![];
    // Depth of the open @font-face block, if inside one.
    let mut font_face: Option<usize> = None;
    let mut pending_font_face = false;
    let mut i = 0;
    while i < toks.len() {
        let t = &toks[i];
        let in_url_fn = stack.iter().flatten().find(|f| is_url_function(f)).cloned();
        match t {
            Tok::AtKeyword(name) => match name.to_ascii_lowercase().as_str() {
                "import" => return Some("@import is not allowed; put everything in the theme's own files".into()),
                "layer" => return Some("@layer is not allowed in a theme; Aura uses cascade layers to protect its approval prompts".into()),
                "font-face" => pending_font_face = true,
                _ => {}
            },
            Tok::Url(v) if !is_data_url(v) => return Some(format!("url({}) is not allowed: {NOT_LOADED}", short(v))),
            Tok::BadUrl => return Some("a url(…) that does not parse is not allowed".into()),
            Tok::Str(v) if in_url_fn.is_some() && !is_data_url(v) => {
                return Some(format!("{}(\"{}\") is not allowed: {NOT_LOADED}", in_url_fn.unwrap_or_default(), short(v)));
            }
            Tok::Function(name) => {
                let f = unprefixed(name);
                if f == "local" {
                    return Some("local() fonts are not allowed in a theme; embed the font as a data: URL".into());
                }
                if f == "element" {
                    return Some("element() is not allowed in a theme: it paints another part of the page".into());
                }
                if let Some(outer) = &in_url_fn {
                    if !is_url_function(&f) {
                        return Some(format!("{f}() inside {outer}() is not allowed: {NOT_LOADED}"));
                    }
                }
                stack.push(Some(f));
            }
            Tok::LBrace => {
                if pending_font_face {
                    font_face = Some(stack.len());
                    pending_font_face = false;
                }
                stack.push(None);
            }
            Tok::LParen | Tok::LBracket => stack.push(None),
            Tok::RParen | Tok::RBracket | Tok::RBrace => {
                stack.pop();
                if matches!(t, Tok::RBrace) && font_face == Some(stack.len()) {
                    font_face = None;
                }
            }
            Tok::Ident(prop) if font_face.is_some() && prop.eq_ignore_ascii_case("font-family") => {
                // font-family: <name> ;
                let mut words: Vec<String> = vec![];
                let mut j = i + 1;
                while j < toks.len() && matches!(toks[j], Tok::Whitespace | Tok::Colon) {
                    j += 1;
                }
                while j < toks.len() && !matches!(toks[j], Tok::Semicolon | Tok::RBrace) {
                    match &toks[j] {
                        Tok::Str(s) => words.push(s.clone()),
                        Tok::Ident(s) => words.push(s.clone()),
                        _ => {}
                    }
                    j += 1;
                }
                let family = words.join(" ").trim().to_ascii_lowercase();
                if GENERIC_FAMILIES.contains(&family.as_str()) {
                    return Some(format!(
                        "@font-face may not name the font family {family:?}: it is a generic family, which Aura's approval prompts use"
                    ));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Why a token value (which needs no approval) could load something: on top
/// of [`resource_problem`], a URL-bearing or image function in a token is
/// allowed only when every argument is a literal `data:` URL (with image-set
/// resolutions and commas), never `var()` or any other function.
pub fn token_resource_problem(value: &str) -> Option<String> {
    if let Some(p) = resource_problem(value) {
        return Some(p);
    }
    let toks = tokenize(value);
    let mut stack: Vec<Option<String>> = vec![];
    for t in &toks {
        let in_url_fn = stack.iter().flatten().find(|f| is_url_function(f)).cloned();
        match t {
            Tok::Function(name) => {
                let f = unprefixed(name);
                if let Some(outer) = &in_url_fn {
                    if !(f == "url" || f == "src") {
                        return Some(format!(
                            "{f}() inside {outer}() is not allowed in a token: {NOT_LOADED}"
                        ));
                    }
                }
                stack.push(Some(f));
            }
            Tok::LParen | Tok::LBracket | Tok::LBrace => stack.push(None),
            Tok::RParen | Tok::RBracket | Tok::RBrace => {
                stack.pop();
            }
            Tok::Url(_) | Tok::Whitespace | Tok::Comma | Tok::Dimension | Tok::Number => {}
            Tok::Str(v) if is_data_url(v) => {}
            other if in_url_fn.is_some() => {
                return Some(format!(
                    "{}() in a token may hold only literal data: URLs, not {}",
                    in_url_fn.unwrap_or_default(),
                    match other {
                        Tok::Ident(i) => format!("{i:?}"),
                        Tok::Str(s) => format!("\"{}\"", short(s)),
                        _ => "that".to_string(),
                    }
                ));
            }
            _ => {}
        }
    }
    None
}

/// Why `value` is not one CSS value that can only set its own property:
/// no `;`, `{`, `}` or `!important` outside strings and functions.
pub fn single_value_problem(value: &str) -> Option<String> {
    let toks = tokenize(value);
    let mut depth = 0usize;
    let mut bang = false;
    for t in &toks {
        match t {
            Tok::LBrace | Tok::RBrace => return Some("a value may not contain { or }".into()),
            Tok::BadStr | Tok::BadUrl => {
                return Some("a value has an unclosed string or a broken url()".into())
            }
            Tok::Function(_) | Tok::LParen | Tok::LBracket => depth += 1,
            Tok::RParen | Tok::RBracket => depth = depth.saturating_sub(1),
            Tok::Semicolon if depth == 0 => {
                return Some("a value may not contain ; (one value per token)".into())
            }
            Tok::Delim('!') if depth == 0 => bang = true,
            Tok::Ident(i) if bang && i.eq_ignore_ascii_case("important") => {
                return Some("a value may not contain !important".into())
            }
            Tok::Whitespace => {}
            _ => bang = false,
        }
    }
    None
}

/// The `--name: value` declarations directly inside the first rule whose
/// selector is `selector` (compared without whitespace and with either
/// quote), whatever the formatting.
pub fn custom_properties(css: &str, selector: &str) -> Vec<(String, String)> {
    let want: String = selector
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .replace('\'', "\"");
    let chars: Vec<char> = strip_comments(css).chars().collect();
    let mut i = 0;
    let mut prelude = String::new();
    let mut depth = 0usize;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' | '\'' => {
                let (s, n) = raw_string(&chars, i);
                prelude.push_str(&s);
                i = n;
                continue;
            }
            '{' => {
                let sel: String = prelude
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect::<String>()
                    .replace('\'', "\"");
                if depth == 0 && sel == want {
                    let (body, _) = block(&chars, i + 1);
                    return declarations(&body);
                }
                depth += 1;
                prelude.clear();
            }
            '}' => {
                depth = depth.saturating_sub(1);
                prelude.clear();
            }
            ';' if depth == 0 => prelude.clear(),
            _ => prelude.push(c),
        }
        i += 1;
    }
    vec![]
}

fn strip_comments(css: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = css.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
            continue;
        }
        if chars[i] == '"' || chars[i] == '\'' {
            let (s, n) = raw_string(&chars, i);
            out.push_str(&s);
            i = n;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// A quoted string as written, quotes included, and the index after it.
fn raw_string(chars: &[char], start: usize) -> (String, usize) {
    let q = chars[start];
    let mut out = String::from(q);
    let mut i = start + 1;
    while i < chars.len() {
        out.push(chars[i]);
        if chars[i] == '\\' && i + 1 < chars.len() {
            out.push(chars[i + 1]);
            i += 2;
            continue;
        }
        i += 1;
        if chars[i - 1] == q {
            break;
        }
    }
    (out, i)
}

/// The text of a block up to its matching `}`, and the index after it.
fn block(chars: &[char], start: usize) -> (String, usize) {
    let mut out = String::new();
    let mut depth = 0usize;
    let mut i = start;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' || c == '\'' {
            let (s, n) = raw_string(chars, i);
            out.push_str(&s);
            i = n;
            continue;
        }
        match c {
            '{' | '(' | '[' => depth += 1,
            '}' if depth == 0 => return (out, i + 1),
            '}' | ')' | ']' => depth = depth.saturating_sub(1),
            _ => {}
        }
        out.push(c);
        i += 1;
    }
    (out, i)
}

/// Top-level `--name: value` pairs of a declaration block.
fn declarations(body: &str) -> Vec<(String, String)> {
    let chars: Vec<char> = body.chars().collect();
    let mut out = vec![];
    let mut cur = String::new();
    let mut depth = 0usize;
    let mut i = 0;
    let push = |decl: &str, out: &mut Vec<(String, String)>| {
        let decl = decl.trim();
        if let Some((name, value)) = decl.split_once(':') {
            let name = name.trim();
            if name.starts_with("--") {
                let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
                out.push((name.to_string(), value));
            }
        }
    };
    while i < chars.len() {
        let c = chars[i];
        if c == '"' || c == '\'' {
            let (s, n) = raw_string(&chars, i);
            cur.push_str(&s);
            i = n;
            continue;
        }
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            ';' if depth == 0 => {
                push(&cur, &mut out);
                cur.clear();
                i += 1;
                continue;
            }
            _ => {}
        }
        cur.push(c);
        i += 1;
    }
    push(&cur, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_do_not_hide_resources() {
        // The reviewer's bypasses: escaped url(, image-set, @import, and @font-face src.
        for css in [
            r"body { background: u\72l(https://evil.example/x.png) }",
            r"body { background: \75 rl('https://evil.example/x.png') }",
            r#"body { background: image-\73 et("https://evil.example/x.png" 1x) }"#,
            r#"body { background: -webkit-image-set("//evil.example/x.png" 1x) }"#,
            r#"@im\70ort "https://evil.example/x.css";"#,
            r#"@IMPORT url(x.css);"#,
            r#"@font-face { font-family: x; src: url(https://evil.example/f.woff2) format("woff2") }"#,
            r#"@font-face { font-family: x; src: u\rl("https://evil.example/f.woff2") }"#,
            r"body { background: url( /etc/passwd ) }",
            r#"body { background: src("https://evil.example/x.png") }"#,
            r#"body { background: image("x.png") }"#,
            r"@layer aura-protected { dialog { display: none !important } }",
            // The re-review: var() indirection inside image functions, local() fonts, generic families.
            r"body { background-image: image-set(var(--mono) 1x) }",
            r"body { background-image: -webkit-image-set(var(--x) 1x) }",
            r"body { background-image: cross-fade(var(--a), var(--b)) }",
            r"body { background-image: element(#x) }",
            r#"@font-face { font-family: x; src: local("Arial") }"#,
            r#"@font-face { font-family: system-ui; src: url("data:font/woff2;base64,AA") }"#,
            r#"@font-face { font-family: "Sans-Serif"; src: url("data:font/woff2;base64,AA") }"#,
        ] {
            assert!(resource_problem(css).is_some(), "not caught: {css}");
        }
    }

    #[test]
    fn data_urls_and_plain_css_pass() {
        for css in [
            r#"body { background: url(data:image/png;base64,AAAA) }"#,
            r#"body { background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>") }"#,
            r#"@font-face { font-family: x; src: url("data:font/woff2;base64,AAAA") format("woff2") }"#,
            r#".a::before { content: "see https://example.com" } /* https://example.com */"#,
            r#"@media (prefers-color-scheme: dark) { .a { color: red } }"#,
            r#"body { background: image-set("data:image/png;base64,AA" 1x) }"#,
        ] {
            assert_eq!(resource_problem(css), None, "{css}");
        }
    }

    #[test]
    fn tokens_cannot_reach_a_url_through_var() {
        // The re-review's case: a string token, used by another token's image-set().
        assert!(token_resource_problem("image-set(var(--mono) 1x)").is_some());
        assert!(token_resource_problem(r"image-\73 et(var(--mono) 1x)").is_some());
        assert!(token_resource_problem("-webkit-image-set(var(--mono) 1x)").is_some());
        assert!(
            token_resource_problem("cross-fade(var(--a), url(data:image/png;base64,AA))").is_some()
        );
        assert!(token_resource_problem("image(var(--a))").is_some());
        assert!(token_resource_problem("element(#x)").is_some());
        assert!(token_resource_problem("image-set(\"https://evil.example/a.png\" 1x)").is_some());
        assert!(token_resource_problem("image-set(attr(x) 1x)").is_some());
        // Literal data: URLs stay allowed, as do plain values.
        assert_eq!(
            token_resource_problem("url('data:image/svg+xml;utf8,<svg/>')"),
            None
        );
        assert_eq!(
            token_resource_problem(
                "image-set(url(data:image/png;base64,AA) 1x, \"data:image/png;base64,BB\" 2x)"
            ),
            None
        );
        assert_eq!(
            token_resource_problem("\"https://evil.example/a.png\""),
            None,
            "a bare string loads nothing by itself"
        );
        assert_eq!(
            token_resource_problem("color-mix(in srgb, var(--fg) 8%, transparent)"),
            None
        );
    }

    #[test]
    fn a_value_is_one_value() {
        assert!(single_value_problem("red;display:none").is_some());
        assert!(single_value_problem("red } body { display:none").is_some());
        assert!(single_value_problem("red !important").is_some());
        assert!(single_value_problem("red ! IMPORTANT").is_some());
        assert!(single_value_problem("\"unclosed\nx").is_some());
        // Inside strings and functions, ; and ! are just text.
        assert_eq!(single_value_problem("\"a;b!important\""), None);
        assert_eq!(
            single_value_problem("url('data:image/svg+xml;utf8,<svg/>')"),
            None
        );
        assert_eq!(single_value_problem("url(data:image/svg+xml;utf8,x)"), None);
        assert_eq!(
            single_value_problem("color-mix(in srgb, var(--fg) 8%, transparent)"),
            None
        );
        assert_eq!(
            single_value_problem("0 1px 2px rgb(0 0 0 / 0.3), 0 1px 3px 1px rgb(0 0 0 / 0.15)"),
            None
        );
        assert_eq!(
            single_value_problem("\"Google Sans\", system-ui, sans-serif"),
            None
        );
    }

    #[test]
    fn custom_properties_whatever_the_formatting() {
        let compact = ":root{--a:1px;--b:var(--a)}:root[data-theme=\"light\"]{--a:2px}";
        assert_eq!(
            custom_properties(compact, ":root"),
            [
                ("--a".into(), "1px".into()),
                ("--b".into(), "var(--a)".into())
            ]
        );
        assert_eq!(
            custom_properties(compact, ":root[data-theme=\"light\"]"),
            [("--a".to_string(), "2px".to_string())]
        );
        let messy = r#"
/* :root { --fake: 1 } in a comment */
@media print { :root { --print: 1 } }
.x { color: red }
:root
{
  color-scheme: dark; --one: 1px;   --two:
     0 1px 2px rgb(0 0 0 / 0.3),
     0 2px 4px rgb(0 0 0 / 0.2);
  --icon: url('data:image/svg+xml;utf8,<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
  /* a comment */ --three: "a;b";
}
:root[data-theme='light'] { --one: 2px }
"#;
        let dark = custom_properties(messy, ":root");
        let names: Vec<&str> = dark.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["--one", "--two", "--icon", "--three"]);
        assert_eq!(
            dark[1].1,
            "0 1px 2px rgb(0 0 0 / 0.3), 0 2px 4px rgb(0 0 0 / 0.2)"
        );
        assert!(dark[2].1.starts_with("url('data:image/svg+xml;utf8,<svg"));
        assert_eq!(dark[3].1, "\"a;b\"");
        assert_eq!(
            custom_properties(messy, ":root[data-theme=\"light\"]"),
            [("--one".to_string(), "2px".to_string())]
        );
    }
}
