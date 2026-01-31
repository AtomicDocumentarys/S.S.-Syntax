const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get('token');
if (token) {
    localStorage.setItem('discord_token', token);
    window.history.replaceState({}, '', '/');  // Clean up URL
}
