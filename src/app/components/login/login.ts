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

  constructor(private router: Router) {
    if (typeof window !== 'undefined' && localStorage.getItem('tradescout_auth') === 'true') {
      this.router.navigate(['/dashboard']);
    }
  }

  onLogin() {
    if (this.username.trim() === 'admin' && this.password.trim() === 'admin') {
      if (typeof window !== 'undefined') {
        localStorage.setItem('tradescout_auth', 'true');
      }
      this.router.navigate(['/dashboard']);
    } else {
      this.errorMessage = 'Неправильний логін або пароль. Спробуйте admin / admin';
    }
  }
}
