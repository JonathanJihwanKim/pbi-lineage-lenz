"""Indent-aware TMDL block parser.

TMDL is a YAML-like indent-significant text format used by Power BI / Fabric to
describe tabular semantic models. This parser does not aim for a full grammar;
it produces a generic block tree (`TmdlBlock`) that downstream code shapes into
typed `Measure` / `Table` / `Relationship` objects.

Design choices:

- Tab-based indentation is canonical. Four-space indentation is normalized.
- A block is identified by its leading keyword (``table``, ``column``,
  ``measure``, ``partition``, ``relationship``, ``expression``, ``function``,
  ``calculationGroup``, ``calculationItem``, ``role``, ``perspective``,
  ``model``, ``database``, ``cultures``).
- A header line may end with ``= <value>`` (single-line value), bare ``=``
  (multi-line expression body follows at deeper indent), or ``= ```` (fenced
  multi-line expression terminated by a matching ```` line).
- Property lines come in three flavours:
  * ``key: value`` — typed property (``dataType: int64``)
  * ``key`` — boolean flag (``isHidden``)
  * ``key = value`` / ``annotation Name = value`` — annotation-like
- Unknown content is preserved on ``raw_properties`` and ``warnings`` rather
  than raising — TMDL is a moving target (UDFs, calc groups, future preview
  syntax) and the parser must degrade gracefully.
"""

from __future__ import annotations

from dataclasses import dataclass, field

BLOCK_KEYWORDS: frozenset[str] = frozenset(
    {
        "table",
        "column",
        "measure",
        "partition",
        "relationship",
        "expression",
        "function",
        "calculationGroup",
        "calculationItem",
        "role",
        "perspective",
        "model",
        "database",
        "cultures",
        "linguisticMetadata",
        "namedExpression",
        # Composite metadata constructs whose children are nested properties.
        "refreshPolicy",
        "hierarchy",
        "level",
        "variation",
        "kpi",
        "object",
        "tableObject",
        "attributeHierarchy",
        "relatedColumnDetails",
        "queryGroup",
    }
)

EXPRESSION_HOLDING_KEYWORDS: frozenset[str] = frozenset(
    {"measure", "expression", "function", "calculationItem", "column"}
)

ANNOTATION_KEYWORDS: frozenset[str] = frozenset({"annotation", "changedProperty", "extendedProperty"})

FENCE = "```"


@dataclass
class TmdlBlock:
    keyword: str
    name: str = ""
    inline_value: str | None = None
    expression: str = ""
    description: str | None = None
    """Doc-comment text collected from `///` lines immediately above the block."""
    properties: dict[str, str] = field(default_factory=dict)
    flags: set[str] = field(default_factory=set)
    annotations: dict[str, str] = field(default_factory=dict)
    children: list[TmdlBlock] = field(default_factory=list)
    raw_properties: dict[str, str] = field(default_factory=dict)


def parse(content: str) -> tuple[list[TmdlBlock], list[str]]:
    """Parse a TMDL document. Returns (top-level blocks, warnings)."""
    parser = _Parser(content)
    blocks = parser._parse_blocks(min_indent=0)
    return blocks, parser.warnings


# --------------------------------------------------------------------------- #
# Internal parser
# --------------------------------------------------------------------------- #


def _expand_indent(line: str) -> tuple[int, str]:
    """Return (indent units, content). One unit = one tab or four spaces."""
    n_tabs = 0
    n_spaces = 0
    for ch in line:
        if ch == "\t":
            n_tabs += 1
        elif ch == " ":
            n_spaces += 1
        else:
            break
    indent = n_tabs + (n_spaces // 4)
    return indent, line[n_tabs + n_spaces :]


def _find_unquoted(s: str, ch: str, start: int = 0) -> int:
    """Find character ``ch`` not inside single-quoted segments. -1 if absent."""
    in_quote = False
    i = start
    while i < len(s):
        c = s[i]
        if c == "'":
            # Look ahead for `''` escape inside a quoted segment
            if in_quote and i + 1 < len(s) and s[i + 1] == "'":
                i += 2
                continue
            in_quote = not in_quote
        elif c == ch and not in_quote:
            return i
        i += 1
    return -1


def _unquote(name: str) -> str:
    name = name.strip()
    if len(name) >= 2 and name[0] == "'" and name[-1] == "'":
        return name[1:-1].replace("''", "'")
    return name


def _strip_doc_marker(content: str) -> str:
    """Strip the leading `///` (and one optional space) from a TMDL doc-comment line."""
    body = content[3:]
    if body.startswith(" "):
        body = body[1:]
    return body.rstrip()


class _Parser:
    def __init__(self, content: str) -> None:
        self.lines = content.splitlines()
        self.i = 0
        self.warnings: list[str] = []

    # ----- low-level helpers -----

    def _at_end(self) -> bool:
        return self.i >= len(self.lines)

    def _skip_blank(self) -> None:
        while not self._at_end() and self.lines[self.i].strip() == "":
            self.i += 1

    def _peek_indent(self) -> tuple[int, str] | None:
        self._skip_blank()
        if self._at_end():
            return None
        return _expand_indent(self.lines[self.i])

    # ----- block-level parsing -----

    def _parse_blocks(self, min_indent: int) -> list[TmdlBlock]:
        blocks: list[TmdlBlock] = []
        pending_doc: list[str] = []
        while True:
            peeked = self._peek_indent()
            if peeked is None:
                break
            indent, content = peeked
            if indent < min_indent:
                break
            if indent > min_indent:
                # Stray over-indented line at the start of a block search; skip with warning.
                self.warnings.append(f"unexpected indent {indent} > {min_indent}: {content!r}")
                self.i += 1
                continue

            if content.startswith("///"):
                pending_doc.append(_strip_doc_marker(content))
                self.i += 1
                continue

            # Decide whether this line starts a block or is an annotation/changedProperty.
            head_keyword = content.split(None, 1)[0]
            if head_keyword in BLOCK_KEYWORDS:
                block = self._parse_block(indent)
                if pending_doc:
                    block.description = "\n".join(pending_doc)
                    pending_doc = []
                blocks.append(block)
            else:
                if pending_doc:
                    self.warnings.append(
                        f"doc-comment(s) preceded a non-block line and were dropped: {pending_doc!r}"
                    )
                    pending_doc = []
                # Top-level annotations / changedProperty / stray properties.
                # Wrap into a synthetic "stray" block so callers don't lose them.
                stray = TmdlBlock(keyword="<stray>")
                self._consume_property_line(stray, content)
                blocks.append(stray)
        if pending_doc:
            self.warnings.append(
                f"trailing doc-comment(s) with no following block: {pending_doc!r}"
            )
        return blocks

    def _parse_block(self, indent: int) -> TmdlBlock:
        content = self.lines[self.i].lstrip("\t ")
        self.i += 1
        block = self._parse_header(content)
        self._fill_block(block, child_indent=indent + 1)
        return block

    def _parse_header(self, content: str) -> TmdlBlock:
        eq = _find_unquoted(content, "=")
        if eq >= 0:
            head = content[:eq].rstrip()
            inline = content[eq + 1 :].strip()
        else:
            head = content.rstrip()
            inline = None

        parts = head.split(None, 1)
        keyword = parts[0]
        name = _unquote(parts[1]) if len(parts) > 1 else ""

        block = TmdlBlock(keyword=keyword, name=name, inline_value=inline)
        return block

    def _fill_block(self, block: TmdlBlock, child_indent: int) -> None:
        # 1. Resolve any expression body attached to the header itself.
        # Body must be deeper than property level, so value_indent = child_indent + 1.
        if block.keyword in EXPRESSION_HOLDING_KEYWORDS and block.inline_value is not None:
            block.expression = self._materialize_expression(
                inline_value=block.inline_value, value_indent=child_indent + 1
            )

        # 2. Consume children + properties at exactly `child_indent`.
        pending_doc: list[str] = []
        while True:
            peeked = self._peek_indent()
            if peeked is None:
                break
            indent, content = peeked
            if indent < child_indent:
                break
            if indent > child_indent:
                # We expected a property/child at child_indent but got deeper.
                # Most likely a stray continuation; skip with warning.
                self.warnings.append(
                    f"unexpected deeper indent {indent}>{child_indent}: {content!r}"
                )
                self.i += 1
                continue

            if content.startswith("///"):
                pending_doc.append(_strip_doc_marker(content))
                self.i += 1
                continue

            head_keyword = content.split(None, 1)[0]
            if head_keyword in BLOCK_KEYWORDS:
                child = self._parse_block(child_indent)
                if pending_doc:
                    child.description = "\n".join(pending_doc)
                    pending_doc = []
                block.children.append(child)
            else:
                if pending_doc:
                    self.warnings.append(
                        f"doc-comment(s) preceded a non-block line and were dropped: {pending_doc!r}"
                    )
                    pending_doc = []
                self._consume_property_line(block, content)
        if pending_doc:
            self.warnings.append(
                f"trailing doc-comment(s) with no following block: {pending_doc!r}"
            )

    # ----- property-level parsing -----

    def _consume_property_line(self, block: TmdlBlock, content: str) -> None:
        """Handle a single property line at `child_indent` and any multi-line value."""
        # Move past this line first; we may need to read more lines for multi-line values.
        line_indent, _ = _expand_indent(self.lines[self.i])
        self.i += 1

        head_token = content.split(None, 1)[0]

        # `annotation Name = value`  /  `extendedProperty Name = value`
        if head_token in ANNOTATION_KEYWORDS and head_token != "changedProperty":
            rest = content[len(head_token) :].strip()
            eq = _find_unquoted(rest, "=")
            if eq < 0:
                # Bare annotation token — treat as flag for safety
                block.flags.add(content)
                return
            ann_name = rest[:eq].strip()
            ann_value = rest[eq + 1 :].strip()
            ann_value = self._maybe_continue_value(ann_value, value_indent=line_indent + 1)
            block.annotations[ann_name] = ann_value
            return

        # `changedProperty = X`
        if head_token == "changedProperty":
            eq = _find_unquoted(content, "=")
            if eq >= 0:
                block.annotations.setdefault("changedProperty:" + content[eq + 1 :].strip(), "")
            else:
                block.flags.add(content)
            return

        # `key: value`
        colon = _find_unquoted(content, ":")
        eq = _find_unquoted(content, "=")
        if colon >= 0 and (eq < 0 or colon < eq):
            key = content[:colon].strip()
            value = content[colon + 1 :].strip()
            block.properties[key] = value
            return

        # `key = value`  (or `key =` multi-line)
        if eq >= 0:
            key = content[:eq].strip()
            value = content[eq + 1 :].strip()
            value = self._maybe_continue_value(value, value_indent=line_indent + 1)
            # Special-case: when `source = <M expression>` on a partition,
            # caller will hoist this into Partition.source_expression later.
            block.properties[key] = value
            return

        # Bare flag, e.g. `isHidden`
        block.flags.add(content.strip())

    # ----- multi-line value plumbing -----

    def _maybe_continue_value(self, inline_value: str, value_indent: int) -> str:
        """If `inline_value` opened a fenced/multi-line expression, consume it.

        Otherwise return `inline_value` unchanged.
        """
        if inline_value == FENCE:
            return self._consume_fenced()
        if inline_value == "":
            return self._consume_indented_block(min_indent=value_indent)
        return inline_value

    def _materialize_expression(self, inline_value: str, value_indent: int) -> str:
        """Same as `_maybe_continue_value` but always returns a string suitable
        for storing as `block.expression` (never None)."""
        if inline_value is None:
            return ""
        return self._maybe_continue_value(inline_value, value_indent)

    def _consume_fenced(self) -> str:
        """Read lines until the next line whose stripped content equals ```."""
        body: list[str] = []
        while not self._at_end():
            line = self.lines[self.i]
            if line.strip() == FENCE:
                self.i += 1
                return _dedent_block(body)
            body.append(line)
            self.i += 1
        self.warnings.append("unterminated triple-backtick block")
        return _dedent_block(body)

    def _consume_indented_block(self, min_indent: int) -> str:
        """Read lines until indent drops below `min_indent`."""
        body: list[str] = []
        while not self._at_end():
            line = self.lines[self.i]
            if line.strip() == "":
                body.append(line)
                self.i += 1
                continue
            indent, _ = _expand_indent(line)
            if indent < min_indent:
                break
            body.append(line)
            self.i += 1
        # Trim trailing blanks
        while body and body[-1].strip() == "":
            body.pop()
        return _dedent_block(body)


def _dedent_block(lines: list[str]) -> str:
    """Strip the common leading whitespace from a block of lines.

    Counts whitespace characters literally (a tab counts as one) so the result
    is faithful to source formatting after the common prefix is removed.
    """
    if not lines:
        return ""
    non_blank = [ln for ln in lines if ln.strip() != ""]
    if not non_blank:
        return "\n".join(lines)
    common = min(len(ln) - len(ln.lstrip("\t ")) for ln in non_blank)
    out = []
    for ln in lines:
        if ln.strip() == "":
            out.append("")
        else:
            out.append(ln[common:] if len(ln) >= common else ln)
    return "\n".join(out).rstrip()
