import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab, redo, undo } from "@codemirror/commands";
import { openSearchPanel, gotoLine } from "@codemirror/search";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";

export function CodeEditor({
  value,
  path,
  disabled,
  onChange,
  onSave,
}: {
  value: string;
  path: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const compartments = useRef({
    language: new Compartment(),
    editable: new Compartment(),
    theme: new Compartment(),
    wrap: new Compartment(),
  });
  const [position, setPosition] = useState("1:1");
  const [wrap, setWrap] = useState(false);
  const [languageError, setLanguageError] = useState("");
  useEffect(() => {
    if (!mount.current) return;
    const c = compartments.current;
    const theme = () =>
      document.documentElement.dataset.theme === "dark" ? oneDark : [];
    const view = new EditorView({
      parent: mount.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([
            indentWithTab,
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
          ]),
          c.language.of([]),
          c.editable.of(EditorState.readOnly.of(disabled)),
          c.theme.of(theme()),
          c.wrap.of([]),
          EditorView.contentAttributes.of({
            "aria-label": "文件内容编辑器",
            spellcheck: "false",
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "var(--surface)",
              color: "var(--ink)",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "Consolas, monospace",
              fontSize: "13px",
            },
            ".cm-gutters": {
              backgroundColor: "var(--surface-raised)",
              color: "var(--muted)",
              borderColor: "var(--border)",
            },
            ".cm-content": { caretColor: "var(--ink)" },
            ".cm-cursor": { borderLeftColor: "var(--ink)" },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              setPosition(`${line.number}:${head - line.from + 1}`);
            }
          }),
        ],
      }),
    });
    editor.current = view;
    const observer = new MutationObserver(() =>
      view.dispatch({ effects: c.theme.reconfigure(theme()) }),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      observer.disconnect();
      view.destroy();
      editor.current = null;
    };
  }, []);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }
  }, [value]);
  useEffect(() => {
    editor.current?.dispatch({
      effects: compartments.current.editable.reconfigure(
        EditorState.readOnly.of(disabled),
      ),
    });
  }, [disabled]);
  useEffect(() => {
    editor.current?.dispatch({
      effects: compartments.current.wrap.reconfigure(
        wrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [wrap]);
  useEffect(() => {
    let active = true;
    setLanguageError("");
    const language = LanguageDescription.matchFilename(languages, path);
    editor.current?.dispatch({
      effects: compartments.current.language.reconfigure([]),
    });
    if (language)
      void language
        .load()
        .then((support) => {
          if (active)
            editor.current?.dispatch({
              effects: compartments.current.language.reconfigure(support),
            });
        })
        .catch((error) => {
          if (active) setLanguageError(String(error));
        });
    return () => {
      active = false;
    };
  }, [path]);
  const command = (run: (view: EditorView) => boolean) => {
    if (editor.current) {
      run(editor.current);
      editor.current.focus();
    }
  };
  return (
    <div className="code-editor-shell">
      <div className="editor-toolbar" aria-label="编辑器工具">
        <button disabled={disabled} onClick={() => command(undo)}>
          撤销
        </button>
        <button disabled={disabled} onClick={() => command(redo)}>
          重做
        </button>
        <button onClick={() => command(openSearchPanel)}>查找 / 替换</button>
        <button onClick={() => command(gotoLine)}>跳转行</button>
        <button aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
          自动换行
        </button>
        <span>
          {position} ·{" "}
          {LanguageDescription.matchFilename(languages, path)?.name ?? "纯文本"}
        </span>
      </div>
      <div ref={mount} className="code-editor-mount" />
      {languageError && <p role="alert">语法加载失败：{languageError}</p>}
    </div>
  );
}
