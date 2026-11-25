# Use Savi on your phone

Your PC must be on, plugged in and awake, with NetBird connected on both the PC and the phone.

1. In VS Code, run **Savi: Pair Phone** and choose **Turn On**. Keep the code it shows. It works once and lasts 10 minutes.
2. On the phone, open the first address shown (it starts with `http://`) in Chrome and download the certificate.
3. In Android **Settings**, search for **CA certificate**, choose **Install anyway**, and pick `savi.crt`. Menu names differ between phones. Android may say the network may be monitored: this certificate is valid only for your PC's address, and the key that could sign others was deleted when it was made.
4. Open the `https://` address and enter the code.
5. In Chrome's menu, choose **Add to Home screen**.

To remove a phone, run **Savi: Paired Devices**. To stop phone access and starting at login, run **Savi: Turn Off Phone Access**. To remove the certificate, look under **User credentials** in Android Settings.

The certificate belongs to one address. If your NetBird address changes, repeat the steps. It also expires after about two years.
