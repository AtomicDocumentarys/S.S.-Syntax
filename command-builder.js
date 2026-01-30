const templates = {
    js: `// JavaScript Template\nconst { user, content } = context;\nreturn \`Hello \${user}, you said: \${content}\`;`,
    
    py: `# Python Template\n# Use 'context' dictionary for data\nprint(f"Hello {context['user']}, welcome to Python execution!")`,
    
    go: `// Go Template (Main body only)\nfmt.Printf("Hello from Go!")`
};

// Function to update the editor when language changes
document.getElementById('commandLanguage').addEventListener('change', (e) => {
    const lang = e.target.value;
    const editor = document.getElementById('commandCode');
    
    // Only update if the editor is empty or has a default template
    if (!editor.value || Object.values(templates).includes(editor.value)) {
        editor.value = templates[lang] || "";
    }
    
    // Update the label
    const labels = { js: 'JavaScript', py: 'Python', go: 'Go (Golang)' };
    document.getElementById('languageDisplay').innerText = labels[lang];
});

async function validateAndCreateCommand() {
    const guildId = currentSelectedGuild; // From server-viewer.js
    if (!guildId) return alert("Select a server first!");

    const command = {
        id: "cmd_" + Date.now(),
        name: document.getElementById('commandName').value,
        type: document.getElementById('commandType').value,
        trigger: document.getElementById('commandTrigger').value || "",
        prefix: document.getElementById('commandPrefix').value || "!",
        language: document.getElementById('commandLanguage').value,
        code: document.getElementById('commandCode').value,
    };

    const res = await fetch('/api/save-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, command })
    });

    if (res.ok) alert("Command Saved & Deployed!");
}
