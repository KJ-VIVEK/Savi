# Connect Google

A one-time setup of about five minutes. You create your own private Google app, so no one else sits between you and your calendar. No billing account is needed.

1. **Create a project** at [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate). Name it `Savi`, and keep it selected for the next steps.
2. **Enable two APIs**: [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) and [Google Tasks API](https://console.cloud.google.com/apis/library/tasks.googleapis.com).
3. **Set up the consent screen** at [Google Auth Platform](https://console.cloud.google.com/auth/overview). Choose **Get started**, enter a name and your email, and pick audience **External**.
4. **Publish it**: under [Audience](https://console.cloud.google.com/auth/audience), choose **Publish app**. If you leave it in Testing, Google signs you out every 7 days. You do not need to submit it for verification for personal use.
5. **Create the client**: under [Clients](https://console.cloud.google.com/auth/clients), choose **Create client**, type **Desktop app**, then **Download JSON**.
6. In VS Code, run **Savi: Connect Google** and choose the downloaded file. You can delete the file afterwards.

In the browser, Google warns that it hasn't verified the app. That is expected, because the app is yours: choose **Advanced**, then **Go to Savi**. Tick both the Calendar and Tasks boxes.

Savi requests permission to view and edit calendar events and tasks, and nothing else. To remove access, run **Savi: Disconnect Google**.
