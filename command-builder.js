async function validateAndCreateCommand() {
    const commandData = {
        id: Date.now().toString(), // Unique ID
        name: document.getElementById('commandName').value,
        type: document.getElementById('commandType').value,
        trigger: document.getElementById('commandTrigger').value,
        language: document.getElementById('commandLanguage').value,
        code: document.getElementById('commandCode').value,
        prefix: document.getElementById('commandPrefix').value || '!',
        lastUpdated: new Date().toISOString()
    };

    // Send to your backend API
    const response = await fetch('/api/commands/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('discord_token')}` },
        body: JSON.stringify(commandData)
    });
    
    if(response.ok) alert("Command Deployed to Vessel!");
      }
