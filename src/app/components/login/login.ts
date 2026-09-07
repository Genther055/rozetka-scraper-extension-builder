import {Component} from '@angular/core';
import {Router} from '@angular/router';
import {FormsModule} from '@angular/forms';
import {CommonModule} from '@angular/common';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.html',
})
export class LoginComponent {
  username = '';
  password = '';
  errorMessage = '';
  loading = false;

  constructor(private router: Router) {
    if (typeof window !== 'undefined' && localStorage.getItem('tradescout_auth') === 'true') {
      this.router.navigate(['/dashboard']);
    }
  }

  async onLogin() {
    if (!this.username.trim() || !this.password.trim()) {
      this.errorMessage = 'Будь ласка, введіть логін та пароль';
      return;
    }

    this.loading = true;
    this.errorMessage = '';

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: this.username.trim(),
          password: this.password.trim()
        })
      });

      const data = await response.json();
      if (response.ok && data.success && data.user) {
        if (typeof window !== 'undefined') {
          localStorage.setItem('tradescout_auth', 'true');
          localStorage.setItem('tradescout_current_user', JSON.stringify(data.user));
          
          // Sync profile settings with logged-in user
          const existingSettingsRaw = localStorage.getItem('tradescout_user_settings_v1') || localStorage.getItem('tradescout_user_settings');
          const existingSettings = existingSettingsRaw ? JSON.parse(existingSettingsRaw) : {};
          existingSettings.username = data.user.displayName || data.user.username;
          existingSettings.role = data.user.role === 'admin' 
            ? 'Головний аналітик (Admin)' 
            : (data.user.role === 'analyst' ? 'Аналітик команди' : data.user.role);
          existingSettings.avatarGradient = data.user.avatarGradient || 'from-indigo-600 to-purple-600';
          existingSettings.avatarInitial = (data.user.displayName || data.user.username).charAt(0).toUpperCase();
          localStorage.setItem('tradescout_user_settings_v1', JSON.stringify(existingSettings));
          localStorage.setItem('tradescout_user_settings', JSON.stringify(existingSettings));
        }
        this.router.navigate(['/dashboard']);
      } else {
        this.errorMessage = data.error || 'Неправильний логін або пароль';
      }
    } catch (e: any) {
      // Offline fallback
      if (this.username.trim() === 'admin' && this.password.trim() === 'admin') {
        if (typeof window !== 'undefined') {
          localStorage.setItem('tradescout_auth', 'true');
        }
        this.router.navigate(['/dashboard']);
      } else {
        this.errorMessage = 'Помилка зв\'язку із сервером авторизації';
      }
    } finally {
      this.loading = false;
    }
  }
}

