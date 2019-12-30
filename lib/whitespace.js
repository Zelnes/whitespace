const {CompositeDisposable, Point, Range} = require('atom')

const TRAILING_WHITESPACE_REGEX = /[ \t]+(?=\r?$)/g

module.exports = class Whitespace {
  constructor () {
    this.watchedEditors = new WeakSet()
    this.subscriptions = new CompositeDisposable()
    /* This map is used to control cursors in multiple tab 
      The key is the TextEditor.id field, as it seems to be unique and stable 
      event when the buffer is renamed
      The value is a set of row positions.
        When inserting text (whatever the text inserted), each row is checked
        and cleaned. The set is cleared after each insertion
        When moving the cursor, the old row position is stored
    */
    this.setOfOldCursorPositions = new Map()
    this.updating = 0

    this.subscriptions.add(atom.workspace.observeTextEditors(editor => {
      return this.handleEvents(editor)
    }))

    this.subscriptions.add(atom.commands.add('atom-workspace', {
      'whitespace:remove-trailing-whitespace': () => {
        let editor = atom.workspace.getActiveTextEditor()

        if (editor) {
          this.removeTrailingWhitespace(editor, editor.getGrammar().scopeName)
        }
      },

      'whitespace:save-with-trailing-whitespace': async () => {
        let editor = atom.workspace.getActiveTextEditor()

        if (editor) {
          this.ignore = true
          await editor.save()
          this.ignore = false
        }
      },

      'whitespace:save-without-trailing-whitespace': () => {
        let editor = atom.workspace.getActiveTextEditor()

        if (editor) {
          this.removeTrailingWhitespace(editor, editor.getGrammar().scopeName)
          editor.save()
        }
      },

      'whitespace:convert-tabs-to-spaces': () => {
        let editor = atom.workspace.getActiveTextEditor()

        if (editor) {
          this.convertTabsToSpaces(editor)
        }
      },

      'whitespace:convert-spaces-to-tabs': () => {
        let editor = atom.workspace.getActiveTextEditor()

        if (editor) {
          return this.convertSpacesToTabs(editor)
        }
      },

      'whitespace:convert-all-tabs-to-spaces': () => {
        let editor = atom.workspace.getActiveTextEditor()

        if (editor) {
          return this.convertTabsToSpaces(editor, true)
        }
      }
    }))
  }

  destroy () {
    return this.subscriptions.dispose()
  }

  getCurrentBufferSet() {
    let id = atom.workspace.getActiveTextEditor().id
    let mapOld = this.setOfOldCursorPositions
    if (!mapOld.has(id))
      mapOld.set(id, new Array())
    return mapOld.get(id)
  }

  appendRowCurrentBuffer(row) {
    console.log("Pushing ", row)
    let setCur = this.getCurrentBufferSet()
    if (setCur.indexOf(row) == -1)
      setCur.push(row)
  }

  updateAndClearCurrentBufferEmptyRows() {
    this.updating = 1
    let setCur = this.getCurrentBufferSet()
    let buffer = atom.workspace.getActiveTextEditor().getBuffer()
    while (setCur.length) {
      let v = setCur.pop()
      console.log("Removing indentation at", v)
      if (buffer.lineLengthForRow(v) && buffer.isRowBlank(v))
        atom.workspace.getActiveTextEditor().setIndentationForBufferRow(v, 0)
    }
    this.updating = 0
  }

  updateSavedRows(from, altered) {
    let tempA = new Array()
    let setCur = this.getCurrentBufferSet()
    let i = 0
    while (i < setCur.length) {
      tempA.push(setCur[i])
      if (setCur[i] > from)
        setCur[i] += altered
      if (setCur[i] < 0)
        setCur.splice(i, 1)
      else
        ++i
    }
    console.log("Array updated", tempA, setCur, from, altered)
  }

  handleEvents (editor) {
    if (this.watchedEditors.has(editor)) return
    let subArray = new Array()

    let buffer = editor.getBuffer()

    subArray.push(buffer.onWillSave(() => {
      return buffer.transact(() => {
        let scopeDescriptor = editor.getRootScopeDescriptor()

        if (atom.config.get('whitespace.removeTrailingWhitespace', {
          scope: scopeDescriptor
        }) && !this.ignore) {
          this.removeTrailingWhitespace(editor, editor.getGrammar().scopeName)
        }

        if (atom.config.get('whitespace.ensureSingleTrailingNewline', {scope: scopeDescriptor})) {
          return this.ensureSingleTrailingNewline(editor)
        }
      })
    }))

    subArray.push(editor.onDidDestroy(event => {
       /* Get rid of informations corresponding to the recently closed editor */
       this.setOfOldCursorPositions.delete(editor.id)
    }))


    subArray.push(buffer.onDidChange(event => {
      if (this.updating == 1)
        return
      let altered = new Array()
      console.log("+++++ Change occured")
/* Try to find the appropriate action on the change */
event.changes.forEach(val => {
        let row = val.newRange.start.row
        console.log(val)
        /* If it is a newline, do an inserted text */
        // if (val.newText === "\n") {
        //   if (!buffer.isRowBlank(row)) {
        //     return
        //   }
        // 
        //   console.log("Doing normal")
        // 
        //   let scopeDescriptor = editor.getRootScopeDescriptor()
        //   if (!atom.config.get('whitespace.ignoreWhitespaceOnlyLines', {
        //     scope: scopeDescriptor
        //   })) {
        //     return editor.setIndentationForBufferRow(row, 0)
        //   }
        // }
        // /* Otherwise, it can be an insertion or deletion, so we need to find the
        //    number of altered lines, and update the recorded positions
        //    accordingly */
        // else
        altered.push({"row":row, "alt":(val.newRange.end.row - row) - (val.oldRange.end.row - val.oldRange.start.row)})
          // this.updateSavedRows(row, val.newRange.end.row - row)
      })
      altered.sort((a,b) => {
        if (a.row > b.row)
          return -1
        return a.row < b.row
      })
      altered.forEach((val) => this.updateSavedRows(val.row, val.alt))

      this.updateAndClearCurrentBufferEmptyRows()
      // editor.transact(() => {this.updateAndClearCurrentBufferEmptyRows()})
      console.log("----- Change end")
    }))

    subArray.push(editor.onWillInsertText(event => {
      console.log("About to add text ?", event)
      editor.getCursorBufferPositions().forEach(pos => {
        if (buffer.lineLengthForRow(pos.row) && buffer.isRowBlank(pos.row)) {
          this.appendRowCurrentBuffer(pos.row)
        }
      })
      // console.log("Rows to change : ", this.getCurrentBufferSet())
    }))

    subArray.push(editor.onDidChangeCursorPosition(event => {
      /* If we moved on the current line, skip it */
      console.log("Cursor", event)
      if (event.textChanged)
        return
      if (event.oldBufferPosition.row === event.newBufferPosition.row)
        return
    
      let row = event.oldBufferPosition.row
    
      if (buffer.lineLengthForRow(row) && buffer.isRowBlank(row)) {
        this.appendRowCurrentBuffer(row)
      }
    }))

    // subArray.push(editor.onDidInsertText(event => {
    //   // console.log("Well, it has been added ", event)
    //   this.dealInsertedText(event.text, event.range.start.row)
    // }))

    let editorDestroyedSubscription = editor.onDidDestroy(() => {
      subArray.forEach((sub) => {
        sub.dispose()
        this.subscriptions.remove(sub)
      })
      this.watchedEditors.delete(editor)
    })

    subArray.forEach((sub) => {
      this.subscriptions.add(sub)
    })

    this.watchedEditors.add(editor)
  }

  removeTrailingWhitespace (editor, grammarScopeName) {
    const buffer = editor.getBuffer()
    const scopeDescriptor = editor.getRootScopeDescriptor()

    // When buffer is same buffer of activeEditor's buffer, don't remove
    // trailing WS at activeEditor's cursor line.
    const activeEditor = atom.workspace.getActiveTextEditor()
    const cursorRows =
      activeEditor && activeEditor.getBuffer() === buffer
        ? new Set(activeEditor.getCursors().map(cursor => cursor.getBufferRow()))
        : new Set()

    const ignoreCurrentLine = atom.config.get('whitespace.ignoreWhitespaceOnCurrentLine', {
      scope: scopeDescriptor
    })

    const ignoreWhitespaceOnlyLines = atom.config.get('whitespace.ignoreWhitespaceOnlyLines', {
      scope: scopeDescriptor
    })

    const keepMarkdownLineBreakWhitespace =
      grammarScopeName === ('source.gfm' || 'text.md') &&
      atom.config.get('whitespace.keepMarkdownLineBreakWhitespace')

    buffer.transact(() => {
      // TODO - remove this conditional after Atom 1.19 stable is released.
      if (buffer.findAllSync) {
        const ranges = buffer.findAllSync(TRAILING_WHITESPACE_REGEX)
        for (let i = 0, n = ranges.length; i < n; i++) {
          const range = ranges[i]
          const row = range.start.row
          const trailingWhitespaceStart = ranges[i].start.column
          if (ignoreCurrentLine && cursorRows.has(row)) continue
          if (ignoreWhitespaceOnlyLines && trailingWhitespaceStart === 0) continue
          if (keepMarkdownLineBreakWhitespace) {
            const whitespaceLength = range.end.column - range.start.column
            if (trailingWhitespaceStart > 0 && whitespaceLength >= 2) continue
          }
          buffer.delete(ranges[i])
        }
      } else {
        for (let row = 0, lineCount = buffer.getLineCount(); row < lineCount; row++) {
          const line = buffer.lineForRow(row)
          const lastCharacter = line[line.length - 1]
          if (lastCharacter === ' ' || lastCharacter === '\t') {
            const trailingWhitespaceStart = line.search(TRAILING_WHITESPACE_REGEX)
            if (ignoreCurrentLine && cursorRows.has(row)) continue
            if (ignoreWhitespaceOnlyLines && trailingWhitespaceStart === 0) continue
            if (keepMarkdownLineBreakWhitespace) {
              const whitespaceLength = line.length - trailingWhitespaceStart
              if (trailingWhitespaceStart > 0 && whitespaceLength >= 2) continue
            }
            buffer.delete(Range(Point(row, trailingWhitespaceStart), Point(row, line.length)))
          }
        }
      }
    })
  }

  ensureSingleTrailingNewline (editor) {
    let selectedBufferRanges
    let row
    let buffer = editor.getBuffer()
    let lastRow = buffer.getLastRow()

    if (buffer.lineForRow(lastRow) === '') {
      row = lastRow - 1

      while (row && buffer.lineForRow(row) === '') {
        buffer.deleteRow(row--)
      }
    } else {
      selectedBufferRanges = editor.getSelectedBufferRanges()
      buffer.append('\n')
      editor.setSelectedBufferRanges(selectedBufferRanges)
    }
  }

  convertTabsToSpaces (editor, convertAllTabs) {
    let buffer = editor.getBuffer()
    let spacesText = new Array(editor.getTabLength() + 1).join(' ')
    let regex = (convertAllTabs ? /\t/g : /^\t+/g)

    buffer.transact(function () {
      return buffer.scan(regex, function ({replace}) {
        return replace(spacesText)
      })
    })

    return editor.setSoftTabs(true)
  }

  convertSpacesToTabs (editor) {
    let buffer = editor.getBuffer()
    let scope = editor.getRootScopeDescriptor()
    let fileTabSize = editor.getTabLength()

    let userTabSize = atom.config.get('editor.tabLength', {
      scope: scope
    })

    let regex = new RegExp(' '.repeat(fileTabSize), 'g')

    buffer.transact(function () {
      return buffer.scan(/^[ \t]+/g, function ({matchText, replace}) {
        return replace(matchText.replace(regex, '\t').replace(/[ ]+\t/g, '\t'))
      })
    })

    editor.setSoftTabs(false)

    if (fileTabSize !== userTabSize) {
      return editor.setTabLength(userTabSize)
    }
  }
}
