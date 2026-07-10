# HTML Prompt File

Create the prompt page from [assets/prompt-page-template.html](assets/prompt-page-template.html). Copy the template into the destination file, then replace its placeholders. The finished page must remain self-contained; it must not load files from the skill directory.

## Location and name

- If the user supplies a file path, use it.
- Otherwise, save the file in the `prompts` directory beside this reference file, creating the directory when needed.
- Choose the page's three-to-five-word heading before naming the file. Use that heading as the document title and convert it to a lowercase, hyphen-separated filename ending in `.html`. Remove punctuation and characters that are invalid in filenames. For example, `Add Team Invitations` becomes `add-team-invitations.html`.

## Fill the template

- Replace `{{TITLE}}` with the chosen heading, escaped for HTML.
- Replace `{{HEADING}}` with the same escaped heading.
- Replace `{{PROMPT}}` with the finished prompt, escaping `&`, `<`, and `>` so it remains literal textarea content.
- Preserve the template's structure, styling, accessibility labels, and behavior unless the user requests a design change.
- Confirm that no template placeholders remain and that the page opens without external assets or dependencies.
