import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
    });
  }

  async sendOtp(to: string, code: string, fullName?: string): Promise<void> {
    const displayName = fullName || to.split('@')[0];

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Mã xác thực SpotWay</title>
</head>
<body style="margin:0;padding:0;background:#0b0b1a;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b1a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#1a1a2e;border-radius:16px;border:1px solid rgba(255,255,255,0.08);overflow:hidden;max-width:560px;">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#a078ff,#5de6ff);padding:32px 40px;text-align:center;">
              <div style="font-size:28px;font-weight:700;color:#0b0b1a;letter-spacing:-0.02em;font-family:'Space Grotesk',Arial,sans-serif;">⚡ SpotWay</div>
              <div style="font-size:14px;color:rgba(0,0,0,0.6);margin-top:4px;">Indoor Spatial Intelligence</div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <h1 style="color:#ffffff;font-size:22px;font-weight:600;margin:0 0 12px;font-family:'Space Grotesk',Arial,sans-serif;">Xác thực địa chỉ Email của bạn</h1>
              <p style="color:#cbc3d7;font-size:14px;line-height:1.6;margin:0 0 24px;">
                Xin chào <strong style="color:#ffffff;">${displayName}</strong>,<br/>
                Cảm ơn bạn đã đăng ký SpotWay. Nhập mã bên dưới để xác thực email và hoàn tất đăng ký:
              </p>
              <!-- OTP Code Box -->
              <div style="background:#0b0b1a;border:1px solid rgba(93,230,255,0.3);border-radius:12px;padding:24px;text-align:center;margin:0 0 24px;">
                <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#5de6ff;margin-bottom:12px;font-weight:600;">Mã xác thực OTP</div>
                <div style="font-size:40px;font-weight:700;letter-spacing:0.2em;color:#5de6ff;font-family:'Space Grotesk',monospace;">${code}</div>
                <div style="font-size:12px;color:#958ea0;margin-top:10px;">Có hiệu lực trong 15 phút</div>
              </div>
              <!-- Warning -->
              <div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);border-radius:8px;padding:12px 16px;margin:0 0 24px;">
                <p style="color:#fca5a5;font-size:12px;margin:0;">
                  🔒 <strong>Bảo mật:</strong> Không chia sẻ mã này với bất kỳ ai. SpotWay sẽ không bao giờ hỏi mã xác thực của bạn.
                </p>
              </div>
              <p style="color:#6c667a;font-size:12px;line-height:1.5;margin:0;">
                Nếu bạn không tạo tài khoản SpotWay, hãy bỏ qua email này.<br/>
                Mã sẽ tự động hết hạn sau 15 phút.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
              <p style="color:#6c667a;font-size:11px;margin:0;">© 2026 SpotWay Spatial Intelligence. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    try {
      await this.transporter.sendMail({
        from: process.env.MAIL_FROM || `SpotWay <${process.env.MAIL_USER}>`,
        to,
        subject: `${code} là mã xác thực SpotWay của bạn`,
        html,
        text: `Mã xác thực SpotWay của bạn là: ${code}\n\nMã có hiệu lực trong 15 phút.\nKhông chia sẻ mã này với ai.`,
      });
      this.logger.log(`OTP sent to ${to}`);
    } catch (err) {
      this.logger.error(`Failed to send OTP to ${to}`, err);
      throw err;
    }
  }
}

