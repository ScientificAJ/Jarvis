Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Start Jarvis'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(500, 180)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Enter your OpenRouter API key for this session:'
$label.Location = New-Object System.Drawing.Point(18, 18)
$label.Size = New-Object System.Drawing.Size(440, 24)
$form.Controls.Add($label)

$keyBox = New-Object System.Windows.Forms.TextBox
$keyBox.Location = New-Object System.Drawing.Point(20, 48)
$keyBox.Size = New-Object System.Drawing.Size(444, 24)
$keyBox.UseSystemPasswordChar = $true
$form.Controls.Add($keyBox)

$start = New-Object System.Windows.Forms.Button
$start.Text = 'Prepare Jarvis'
$start.Location = New-Object System.Drawing.Point(335, 87)
$start.Size = New-Object System.Drawing.Size(129, 30)
$start.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($start)
$form.AcceptButton = $start
$form.Add_Shown({ $form.Activate(); [void]$keyBox.Focus() })

$result = $form.ShowDialog()
if ($result -ne [System.Windows.Forms.DialogResult]::OK -or [string]::IsNullOrWhiteSpace($keyBox.Text)) {
    $form.Dispose()
    exit 2
}
[Console]::Out.Write($keyBox.Text.Trim())
$form.Dispose()
