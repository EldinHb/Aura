import { memo, useMemo } from "react";
import hljs from "highlight.js/lib/common";
import { useStore } from "../../state/store";

export const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language: string }) {
  const lang = language.toLowerCase();
  const highlighted = useMemo(() => {
    // Keep very large output cheap to render while retaining its formatting.
    if (code.length > 100_000 || !hljs.getLanguage(lang)) return null;
    try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; }
    catch { return null; }
  }, [code, lang]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      useStore.getState().toast("Code copied");
    } catch (error) {
      useStore.getState().toast(`Could not copy code: ${String(error)}`, "error");
    }
  };
  return (
    <div className="code-block">
      <div className="code-block-head"><span>{language || "code"}</span>
        <button type="button" className="btn small" data-hint aria-label="Copy code" onClick={() => void copy()}>Copy</button>
      </div>
      <pre className="md-pre" tabIndex={0} aria-label={`${language || "Plain text"} code`}>
        {highlighted === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={{ __html: highlighted }} />}
      </pre>
    </div>
  );
});
