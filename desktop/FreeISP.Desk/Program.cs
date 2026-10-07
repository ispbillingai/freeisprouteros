using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FreeISP.Desk
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new DeskWindow());
        }
    }

    internal sealed class DeskWindow : Form
    {
        private readonly WebView2 browser = new WebView2 { Dock = DockStyle.Fill };
        private readonly TextBox address = new TextBox { Width = 330, Text = "http://127.0.0.1:8874" };
        private readonly Button connect = new Button { Text = "Connect", AutoSize = true, Enabled = false };
        private readonly ToolStripStatusLabel status = new ToolStripStatusLabel("Starting browser…");
        private Uri router;

        public DeskWindow()
        {
            Text = "FreeISP Desk";
            Size = new Size(1280, 860);
            MinimumSize = new Size(860, 600);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9);
            var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 42, Padding = new Padding(8), BackColor = Color.FromArgb(222, 228, 235) };
            toolbar.Controls.Add(new Label { Text = "Router address", AutoSize = true, Margin = new Padding(0, 5, 8, 0) });
            toolbar.Controls.Add(address);
            toolbar.Controls.Add(connect);
            var reload = new Button { Text = "Reload", AutoSize = true };
            reload.Click += (s, e) => { if (browser.CoreWebView2 != null) browser.Reload(); };
            toolbar.Controls.Add(reload);
            var disconnect = new Button { Text = "Disconnect", AutoSize = true };
            disconnect.Click += async (s, e) => {
                if (browser.CoreWebView2 == null) return;
                router = null;
                browser.CoreWebView2.Stop();
                browser.CoreWebView2.Navigate("about:blank");
                await browser.CoreWebView2.Profile.ClearBrowsingDataAsync();
                status.Text = "Disconnected. Local browser session cleared.";
            };
            toolbar.Controls.Add(disconnect);
            var bar = new StatusStrip();
            bar.Items.Add(status);
            Controls.Add(browser);
            Controls.Add(toolbar);
            Controls.Add(bar);
            connect.Click += (s, e) => ConnectRouter();
            address.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter && connect.Enabled) { e.SuppressKeyPress = true; ConnectRouter(); } };
            Shown += async (s, e) => {
                try {
                    string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FreeISP", "Desk", "Browser");
                    var environment = await CoreWebView2Environment.CreateAsync(null, profile);
                    await browser.EnsureCoreWebView2Async(environment);
                    browser.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;
                    browser.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
                    browser.CoreWebView2.NavigationStarting += (sender, args) => {
                        if (args.Uri == "about:blank") return;
                        Uri target;
                        if (router == null || !Uri.TryCreate(args.Uri, UriKind.Absolute, out target) || target.Scheme != router.Scheme || target.Authority != router.Authority) {
                            args.Cancel = true;
                            status.Text = "Navigation outside the connected router was blocked.";
                        }
                    };
                    browser.CoreWebView2.NewWindowRequested += (sender, args) => { args.Handled = true; status.Text = "Open external links in your normal browser."; };
                    browser.CoreWebView2.NavigationCompleted += (sender, args) => {
                        if (router != null) status.Text = args.IsSuccess ? "Connected to " + router.Authority : "Connection failed: " + args.WebErrorStatus + ". Check the router or SSH tunnel, then retry.";
                    };
                    connect.Enabled = true;
                    status.Text = "Enter a FreeISP router address and click Connect. The VPS test address needs the SSH tunnel running.";
                }
                catch (Exception ex) {
                    status.Text = "Browser could not start.";
                    MessageBox.Show("FreeISP Desk needs Microsoft Edge WebView2 Runtime.\n\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            };
        }

        private void ConnectRouter()
        {
            string input = address.Text.Trim();
            if (!input.Contains("://")) input = "https://" + input;
            Uri target;
            if (!Uri.TryCreate(input, UriKind.Absolute, out target) || (target.Scheme != "https" && target.Scheme != "http") || string.IsNullOrEmpty(target.Host) || !string.IsNullOrEmpty(target.UserInfo)) {
                MessageBox.Show("Enter a router address, such as https://10.77.0.1 or http://127.0.0.1:8874. Do not include passwords in the address.", Text);
                return;
            }
            router = new Uri(target.GetLeftPart(UriPartial.Authority));
            address.Text = router.AbsoluteUri;
            status.Text = "Connecting to " + router.Authority + "…";
            browser.CoreWebView2.Navigate(new Uri(router, "/cgi-bin/luci/admin/freeisp").AbsoluteUri);
        }
    }
}
