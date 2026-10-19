import { AfterViewInit, Component, ElementRef, OnDestroy, forwardRef, input, viewChild } from "@angular/core";
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from "@angular/forms";
import { EditorView, minimalSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, indentOnInput, indentRange, indentUnit } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";

/**
 * Wraps CodeMirror's JavaScript editor as an Angular forms control.
 * The parent feature keeps ownership of the script value while this component
 * manages editor state, syntax highlighting, focus, and disabled behavior.
 */
@Component({
  selector: "nspanel-script-editor",
  standalone: true,
  templateUrl: "./script-editor.component.html",
  styleUrl: "./script-editor.component.css",
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => ScriptEditorComponent), multi: true }]
})
export class ScriptEditorComponent implements ControlValueAccessor, AfterViewInit, OnDestroy {
  /** Screen-reader name associated with CodeMirror's editable text surface. */
  readonly ariaLabel = input("JavaScript function body");
  /** Indicates whether the Format action should be disabled. */
  get isDisabled(): boolean { return this.disabled; }
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>("host");
  private readonly editable = new Compartment();
  private editor?: EditorView;
  private value = "";
  private disabled = false;
  private synchronizing = false;
  private onChange: (value: string) => void = () => undefined;
  private onTouched: () => void = () => undefined;
  private readonly handleBlur = (): void => this.onTouched();

  /** Creates CodeMirror after Angular has rendered the editor host. */
  ngAfterViewInit(): void {
    this.editor = new EditorView({
      state: EditorState.create({
        doc: this.value,
        extensions: [
          minimalSetup,
          javascript(),
          bracketMatching(),
          indentOnInput(),
          indentUnit.of("  "),
          this.editable.of(EditorView.editable.of(!this.disabled)),
          EditorView.contentAttributes.of({ "aria-label": this.ariaLabel() }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || this.synchronizing) return;
            this.value = update.state.doc.toString();
            this.onChange(this.value);
          }),
          EditorView.theme({
            "&": { border: "1px solid #d3ddda", borderRadius: "8px", backgroundColor: "#fff", fontSize: "12px" },
            "&.cm-focused": { outline: "3px solid #72b9a822", borderColor: "#83b8a8" },
            ".cm-content": { minHeight: "420px", padding: "9px 0", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
            ".cm-gutters": { borderRight: "1px solid #edf1ef", backgroundColor: "#f8faf9", color: "#87928f" },
            ".cm-line": { padding: "0 10px" },
            ".cm-matchingBracket": { backgroundColor: "#d7f0e3", outline: "1px solid #5b9a79", color: "inherit" },
            ".cm-nonmatchingBracket": { backgroundColor: "#ffe0df", outline: "1px solid #c75b55", color: "inherit" }
          })
        ]
      }),
      parent: this.host().nativeElement
    });
    this.editor.contentDOM.addEventListener("blur", this.handleBlur);
  }

  /** Releases the CodeMirror view and its event listener with the Angular control. */
  ngOnDestroy(): void {
    this.editor?.contentDOM.removeEventListener("blur", this.handleBlur);
    this.editor?.destroy();
  }

  /** Receives model changes from Angular and updates CodeMirror without feedback. */
  writeValue(value: unknown): void {
    this.value = typeof value === "string" ? value : "";
    if (!this.editor || this.editor.state.doc.toString() === this.value) return;
    this.synchronizing = true;
    this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: this.value } });
    this.synchronizing = false;
  }

  /** Registers Angular's callback for user-entered script text. */
  registerOnChange(fn: (value: string) => void): void { this.onChange = fn; }

  /** Registers Angular's callback for the editor's touched state. */
  registerOnTouched(fn: () => void): void { this.onTouched = fn; }

  /** Reindents every line using the JavaScript parser and the configured two-space unit. */
  format(): void {
    if (!this.editor || this.disabled || this.editor.state.doc.length === 0) return;
    const state = this.editor.state;
    this.editor.dispatch({ changes: indentRange(state, 0, state.doc.length) });
  }

  /** Enables or disables editing through CodeMirror's editable compartment. */
  setDisabledState(disabled: boolean): void {
    this.disabled = disabled;
    this.editor?.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(!disabled)) });
  }
}
