import { describe, expect, it } from "vitest";
import { githubMarkdown } from "./githubMarkdown";

describe("githubMarkdown", () => {
  it("drops HTML comments, also one left open", () => {
    expect(githubMarkdown("Before <!-- Thanks for the PR! Fill in:\n- [ ] tests --> after")).toBe("Before  after");
    expect(githubMarkdown("Text <!-- never closed")).toBe("Text ");
  });

  it("turns https images into markdown images and drops others", () => {
    expect(githubMarkdown('<img width="400" alt="Screenshot [1]" src="https://github.com/user-attachments/assets/abc.png" />'))
      .toBe("![Screenshot \\[1\\]](https://github.com/user-attachments/assets/abc.png)");
    expect(githubMarkdown('<img src="http://example.com/a.png"><img src="javascript:alert(1)"><img src=data:image/png;base64,xx>')).toBe("");
  });

  it("keeps line breaks, and shows <details> as its summary in bold with the content", () => {
    expect(githubMarkdown("one<br>two<br/>three")).toBe("one  \ntwo  \nthree");
    expect(githubMarkdown("<details><summary>Logs</summary>\n\nline 1\n</details>")).toBe("\n\n**Logs**\n\n\n\nline 1\n\n");
  });

  it("maps simple inline tags to markdown or their text", () => {
    expect(githubMarkdown("<b>bold</b> <strong>strong</strong> <i>it</i> <em>em</em> <code>a`b</code> <kbd>Ctrl</kbd>+<kbd>C</kbd> H<sub>2</sub>O x<sup>2</sup>"))
      .toBe("**bold** **strong** *it* *em* `ab` Ctrl+C H2O x2");
    expect(githubMarkdown('<a href="https://github.com/acme">acme</a> and <a href="javascript:alert(1)">click</a>')).toBe("[acme](https://github.com/acme) and click");
  });

  it("leaves no tag outside code, whatever comes in", () => {
    const hostile = [
      "<script>alert(1)</script>",
      '<iframe src="https://evil.example"></iframe>',
      '<div onclick="steal()">hi</div>',
      '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
      "<<script>script>alert(2)<</script>/script>",
      '<a href="https://ok.example" onclick="x()">ok</a>',
      "<style>body{display:none}</style>",
    ].join("\n");
    const out = githubMarkdown(hostile);
    expect(out).not.toMatch(/<[A-Za-z!/?]/);
    expect(out).toContain("[ok](https://ok.example)");
    expect(out).not.toMatch(/javascript:/);
  });

  it("does not touch code", () => {
    const code = "Use `<br>` here:\n\n```html\n<img src=x onerror=alert(1)>\n<!-- kept -->\n```\nthen <b>done</b>";
    expect(githubMarkdown(code)).toBe("Use `<br>` here:\n\n```html\n<img src=x onerror=alert(1)>\n<!-- kept -->\n```\nthen **done**");
  });

  it("keeps alt and link text from ending the destination (review item 5)", () => {
    expect(githubMarkdown('<img alt="x\\" src="https://ok.example/a.png">')).toBe("![x\\\\](https://ok.example/a.png)");
    expect(githubMarkdown('<img alt="](data:image/png;base64,AAAA)" src="https://ok.example/a.png">')).toBe("![\\]\\(data:image/png;base64,AAAA\\)](https://ok.example/a.png)");
    // A destination with a backslash, a bracket or a backtick is not taken.
    expect(githubMarkdown('<img src="https://ok.example/a\\.png">')).toBe("");
    expect(githubMarkdown('<a href="https://ok.example/x)y">t</a>')).toBe("t");
  });
});
