const CLIENT_ID = "1466792124686008341";
const REDIRECT_URI = window.location.origin + "/callback.html";

function login() {
    const scope = encodeURIComponent("identify guilds");
    window.location.href = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=token&scope=${scope}`;
}

function logout() {
    localStorage.removeItem('discord_token');
    window.location.href = '/';
}

async function checkAuth() {
    const token = localStorage.getItem('discord_token');
    if (!token) return null;

    try {
        const res = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error();
        const user = await res.json();
        
        // Update UI
        document.getElementById('userInfo').innerHTML = `
            <img src="https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png" class="user-avatar">
            <span>${user.username}</span>
            <button class="btn-login" onclick="logout()">Logout</button>
        `;
        document.getElementById('navTabs').style.display = 'flex';
        return token;
    } catch {
        logout();
        return null;
    }
}
