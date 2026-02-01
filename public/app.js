// Secure Frontend Application
class SecureDashboard {
    constructor() {
        this.state = {
            user: null,
            token: null,
            guilds: [],
            selectedGuild: null,
            commands: [],
            csrfToken: null,
            security: {
                csrfEnabled: false,
                encryptionEnabled: false,
                rateLimiting: true,
                auditLogging: true
            }
        };
        
        this.init();
    }
    
    async init() {
        console.log('Secure Dashboard Initializing...');
        
        // Check for security configuration
        this.checkSecurityConfig();
        
        // Parse URL for token
        await this.parseUrlToken();
        
        // Get CSRF token
        await this.fetchCSRFToken();
        
        // Load initial data if authenticated
        if (this.state.token) {
            await this.loadUserData();
        }
        
        // Start status monitoring
        this.startStatusMonitor();
        
        // Show security modal if needed
        setTimeout(() => {
            if (!this.state.token) {
                this.showSecurityModal();
            }
        }, 1000);
    }
    
    async checkSecurityConfig() {
        try {
            const response = await axios.get('/api/status');
            const securityStatus = document.getElementById('securityStatus');
            
            if (response.data.security) {
                securityStatus.textContent = '🔒';
                securityStatus.style.color = '#00ff77';
            } else {
                securityStatus.textContent = '⚠️';
                securityStatus.style.color = '#ffaa00';
            }
        } catch (error) {
            console.warn('Security check failed:', error.message);
        }
    }
    
    async parseUrlToken() {
        const urlParams = new URLSearchParams(window.location.search);
        const tokenParam = urlParams.get('token');
        
        if (tokenParam) {
            try {
                const tokenData = JSON.parse(decodeURIComponent(tokenParam));
                this.state.token = tokenParam;
                
                // Store token in sessionStorage (encrypted already)
                sessionStorage.setItem('auth_token', tokenParam);
                
                // Clean URL
                window.history.replaceState({}, document.title, window.location.pathname);
                
                // Show success message
                this.showNotification('Authentication successful!', 'success');
                
                return true;
            } catch (error) {
                console.error('Token parse error:', error);
                this.showNotification('Invalid authentication token', 'error');
                return false;
            }
        }
        
        // Check session storage
        const storedToken = sessionStorage.getItem('auth_token');
        if (storedToken) {
            this.state.token = storedToken;
            return true;
        }
        
        return false;
    }
    
    async fetchCSRFToken() {
        try {
            const response = await axios.get('/api/csrf-token');
            this.state.csrfToken = response.data.csrfToken;
            document.getElementById('csrfToken').value = this.state.csrfToken;
            this.state.security.csrfEnabled = true;
        } catch (error) {
            console.warn('CSRF token fetch failed:', error.message);
            this.state.security.csrfEnabled = false;
        }
    }
    
    async loadUserData() {
        try {
            // Get user info
            const userResponse = await this.secureRequest('GET', '/api/user-me');
            this.state.user = userResponse.data;
            this.updateUserUI();
            
            // Get mutual servers
            const guildsResponse = await this.secureRequest('GET', '/api/mutual-servers');
            this.state.guilds = guildsResponse.data;
            this.updateGuildSelect();
            
            // Show authenticated UI
            this.showAuthenticatedUI();
            
        } catch (error) {
            console.error('Load user data error:', error);
            if (error.response?.status === 401) {
                this.logout();
            }
        }
    }
    
    async secureRequest(method, url, data = null) {
        const headers = {
            'Authorization': `Bearer ${this.state.token}`,
            'X-CSRF-Token': this.state.csrfToken,
            'Content-Type': 'application/json'
        };
        
        try {
            const config = {
                method,
                url,
                headers,
                data,
                timeout: 10000
            };
            
            const response = await axios(config);
            return response;
        } catch (error) {
            if (error.response?.status === 403 && error.response?.data?.error?.includes('CSRF')) {
                await this.fetchCSRFToken();
                headers['X-CSRF-Token'] = this.state.csrfToken;
                return await axios({
                    method,
                    url,
                    headers,
                    data,
                    timeout: 10000
                });
            }
            throw error;
        }
    }
    
    updateUserUI() {
        const userSection = document.getElementById('userSection');
        const authSection = document.getElementById('authSection');
        const userName = document.getElementById('userName');
        const userDiscriminator = document.getElementById('userDiscriminator');
        const userPfp = document.getElementById('userPfp');
        
        if (this.state.user) {
            userSection.classList.remove('hidden');
            authSection.classList.add('hidden');
            
            userName.textContent = this.state.user.username;
            userDiscriminator.textContent = `#${this.state.user.discriminator}`;
            userPfp.src = `https://cdn.discordapp.com/avatars/${this.state.user.id}/${this.state.user.avatar}.png`;
        } else {
            userSection.classList.add('hidden');
            authSection.classList.remove('hidden');
        }
    }
    
    updateGuildSelect() {
        const guildSelect = document.getElementById('guildSelect');
        const guildInfo = document.getElementById('guildInfo');
        
        guildSelect.innerHTML = '<option value="">Select a server...</option>';
        
        this.state.guilds.forEach(guild => {
            const option = document.createElement('option');
            option.value = guild.id;
            option.textContent = guild.name;
            guildSelect.appendChild(option);
        });
        
        if (this.state.guilds.length > 0) {
            guildSelect.classList.remove('hidden');
            document.querySelectorAll('.s-only').forEach(el => el.classList.remove('hidden'));
        }
    }
    
    showAuthenticatedUI() {
        document.querySelectorAll('.s-only').forEach(el => el.classList.remove('hidden'));
    }
    
    async selectGuild() {
        const guildSelect = document.getElementById('guildSelect');
        const guildId = guildSelect.value;
        
        if (!guildId) {
            this.state.selectedGuild = null;
            return;
        }
        
        this.state.selectedGuild = guildId;
        await this.loadCommands(guildId);
    }
    
    async loadCommands(guildId) {
        try {
            const response = await this.secureRequest('GET', `/api/commands/${guildId}`);
            this.state.commands = response.data;
            this.renderCommands();
            
            document.getElementById('commandCount').textContent = this.state.commands.length;
        } catch (error) {
            console.error('Load commands error:', error);
            this.showNotification('Failed to load commands', 'error');
        }
    }
    
    renderCommands() {
        const commandList = document.getElementById('commandList');
        
        if (this.state.commands.length === 0) {
            commandList.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-code"></i>
                    <h3>No Commands Found</h3>
                    <p>Create your first command for this server</p>
                </div>
            `;
            return;
        }
        
        commandList.innerHTML = '';
        
        this.state.commands.forEach(command => {
            const commandElement = document.createElement('div');
            commandElement.className = 'command-item';
            commandElement.innerHTML = `
                <div class="command-content">
                    <div class="command-header">
                        <h4>${command.trigger}</h4>
                        <span class="command-type">${command.type}</span>
                    </div>
                    <div class="command-details">
                        <span class="command-lang">${command.lang}</span>
                        <span class="command-cooldown">Cooldown: ${command.cooldown || 5000}ms</span>
                    </div>
                    <pre class="command-code">${command.code.substring(0, 100)}...</pre>
                </div>
                <div class="command-actions">
                    <button class="btn btn-secondary btn-sm" onclick="dashboard.editCommand('${command.id}')">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="dashboard.deleteCommand('${command.id}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `;
            commandList.appendChild(commandElement);
        });
    }
    
    async saveCommand() {
        if (!this.state.selectedGuild) {
            this.showNotification('Please select a server first', 'warning');
            return;
        }
        
        const trigger = document.getElementById('cmdTrigger').value.trim();
        const code = document.getElementById('cmdCode').value.trim();
        const type = document.getElementById('cmdType').value;
        const lang = document.getElementById('cmdLang').value;
        const cooldown = parseInt(document.getElementById('cmdCooldown').value);
        
        // Validation
        if (!trigger || !code) {
            this.showNotification('Trigger and code are required', 'error');
            return;
        }
        
        if (!/^[a-zA-Z0-9_-]+$/.test(trigger)) {
            this.showNotification('Trigger can only contain letters, numbers, dashes, and underscores', 'error');
            return;
        }
        
        if (code.length > 1000) {
            this.showNotification('Code is too long (max 1000 characters)', 'error');
            return;
        }
        
        try {
            const commandData = {
                guildId: this.state.selectedGuild,
                command: {
                    trigger,
                    code,
                    type,
                    lang,
                    cooldown: cooldown || 5000,
                    isEdit: false
                }
            };
            
            const saveBtn = document.getElementById('saveCommandBtn');
            saveBtn.classList.add('loading');
            
            const response = await this.secureRequest('POST', '/api/save-command', commandData);
            
            this.showNotification('Command saved securely', 'success');
            this.closeCommandModal();
            await this.loadCommands(this.state.selectedGuild);
            
        } catch (error) {
            console.error('Save command error:', error);
            this.showNotification(error.response?.data?.error || 'Failed to save command', 'error');
        } finally {
            const saveBtn = document.getElementById('saveCommandBtn');
            saveBtn.classList.remove('loading');
        }
    }
    
    async deleteCommand(commandId) {
        if (!confirm('Are you sure you want to delete this command?')) return;
        
        try {
            await this.secureRequest('DELETE', `/api/command/${this.state.selectedGuild}/${commandId}`);
            this.showNotification('Command deleted', 'success');
            await this.loadCommands(this.state.selectedGuild);
        } catch (error) {
            console.error('Delete command error:', error);
            this.showNotification('Failed to delete command', 'error');
        }
    }
    
    async logout() {
        try {
            if (this.state.token) {
                await this.secureRequest('POST', '/api/logout');
            }
        } catch (error) {
            console.warn('Logout API error:', error);
        }
        
        this.state.user = null;
        this.state.token = null;
        this.state.guilds = [];
        this.state.selectedGuild = null;
        
        sessionStorage.removeItem('auth_token');
        
        this.updateUserUI();
        document.querySelectorAll('.s-only').forEach(el => el.classList.add('hidden'));
        
        this.showNotification('Logged out successfully', 'success');
        switchTab('home');
    }
    
    login() {
        const clientId = 'YOUR_CLIENT_ID'; // Should be from environment
        const redirectUri = encodeURIComponent(window.location.origin + '/callback');
        const scope = encodeURIComponent('identify guilds');
        const state = Math.random().toString(36).substring(7);
        
        const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}`;
        window.location.href = authUrl;
    }
    
    showSecurityModal() {
        document.getElementById('securityModal').classList.add('show');
    }
    
    closeSecurityModal() {
        document.getElementById('securityModal').classList.remove('show');
    }
    
    showNotification(message, type = 'info') {
        const container = document.getElementById('notificationContainer');
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <div class="notification-content">
                <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
                <span>${message}</span>
            </div>
            <button class="notification-close" onclick="this.parentElement.remove()">&times;</button>
        `;
        
        container.appendChild(notification);
        
        setTimeout(() => notification.classList.add('show'), 10);
        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
        }, 5000);
    }
    
    startStatusMonitor() {
        setInterval(() => this.checkStatus(), 30000);
        this.checkStatus();
    }
    
    async checkStatus() {
        try {
            const response = await axios.get('/api/status');
            const data = response.data;
            
            // Update bot status
            document.getElementById('botStatus').textContent = data.bot;
            document.getElementById('botStatus').className = `status-indicator ${data.bot.includes('Online') ? 'status-good' : 'status-error'}`;
            
            // Update Redis status
            document.getElementById('redisStatus').textContent = data.redis;
            document.getElementById('redisStatus').className = `status-indicator ${data.redis.includes('Connected') ? 'status-good' : 'status-error'}`;
            
            // Update server count
            document.getElementById('serverCount').textContent = data.guilds || '0';
            
            // Update system info
            document.getElementById('botUptime').textContent = data.uptime || '--';
            document.getElementById('nodeVersion').textContent = data.node || '--';
            document.getElementById('systemEnv').textContent = data.environment || '--';
            document.getElementById('systemMemory').textContent = data.memory?.rss || '--';
            
        } catch (error) {
            console.warn('Status check failed:', error.message);
        }
    }
}

// Global functions for HTML onclick handlers
let dashboard;

function switchTab(tabName) {
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    
    document.getElementById(`v-${tabName}`).classList.add('active');
    document.querySelector(`.nav-item[onclick*="${tabName}"]`).classList.add('active');
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('show');
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
}

function toggleDropdown(event) {
    event.stopPropagation();
    document.getElementById('dropdown').classList.toggle('show');
}

function openNewCommandModal() {
    if (!dashboard.state.selectedGuild) {
        dashboard.showNotification('Please select a server first', 'warning');
        return;
    }
    document.getElementById('commandModal').classList.add('show');
}

function closeCommandModal() {
    document.getElementById('commandModal').classList.remove('show');
}

function addToServer() {
    const clientId = 'YOUR_CLIENT_ID'; // Should match your Discord application
    window.open(`https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot%20applications.commands`, '_blank');
}

// Close dropdowns when clicking outside
document.addEventListener('click', (event) => {
    const dropdowns = document.querySelectorAll('.dropdown-content.show');
    dropdowns.forEach(dropdown => {
        if (!dropdown.parentElement.contains(event.target)) {
            dropdown.classList.remove('show');
        }
    });
});

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    // Load saved theme
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    
    // Initialize dashboard
    dashboard = new SecureDashboard();
    
    // Make dashboard globally available
    window.dashboard = dashboard;
});
