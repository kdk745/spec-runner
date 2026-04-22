# Patient Intake Form - Frontend Only

A single-page patient intake form with full localStorage persistence. All form data is automatically saved and restored across page reloads.

## Features

- ✅ **Pure Frontend** - No server or backend required
- ✅ **Auto-Save** - Form data automatically saves as you type (1-second debounce)
- ✅ **Persistent Storage** - Data persists across page reloads using localStorage
- ✅ **Form Restoration** - Automatically restores your data when you return
- ✅ **No Build Step** - Single HTML file, open directly in browser
- ✅ **Responsive Design** - Works on desktop, tablet, and mobile
- ✅ **Comprehensive Form** - Personal info, medical history, lifestyle, consent sections

## How to Use

### Option 1: Direct File Access
1. Open `index.html` directly in your browser using the file protocol:
   ```
   file:///path/to/index.html
   ```

### Option 2: Local Server (Optional)
For best results with service workers and full compatibility:
```bash
# Using Python 3
python -m http.server 3000

# Using Node.js with serve
npx serve . -l tcp://0.0.0.0:3000

# Using PHP
php -S localhost:3000
```

Then open `http://localhost:3000`

## How It Works

### Auto-Save
- Every field change is automatically saved to localStorage after 1 second
- No manual "Save" button needed
- Clear visual feedback with auto-save notifications

### Data Persistence
- Form data is stored in browser's localStorage under key `patientIntakeForm`
- Data includes:
  - Personal information (name, DOB, gender, contact)
  - Address and location details
  - Medical history (chronic conditions, medications, allergies)
  - Lifestyle habits (smoking, alcohol, exercise)
  - Reason for visit
  - Consent agreements

### Form Features
- **Required Fields**: Marked with red asterisks (*)
- **Validation**: All required fields must be completed before submission
- **Clear Button**: Wipes all data from form and localStorage
- **Submit Button**: Confirms submission and shows success message
- **Auto-Restore**: Previous form data automatically loads on page reload

## Browser Compatibility

Works on all modern browsers that support:
- localStorage API
- ES6 JavaScript
- CSS Grid/Flexbox

Tested on:
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Data Storage

All data is stored locally in your browser's localStorage. No data is sent to any server.

To clear all saved data:
1. Click "Clear Form" button on the form, OR
2. Open browser developer tools (F12) → Application → Local Storage → Delete `patientIntakeForm`

## Form Sections

1. **Personal Information** - Name, date of birth, gender, email, phone
2. **Contact & Address** - Full address details
3. **Medical History** - Chronic conditions, current medications, allergies
4. **Health & Lifestyle** - Smoking, alcohol use, exercise frequency
5. **Reason for Visit** - Primary reason and additional notes
6. **Consent & Agreement** - Data sharing and accuracy confirmation

## Technical Details

- Single HTML file (~12KB)
- No external dependencies
- Pure vanilla JavaScript (no frameworks)
- CSS Grid for responsive layout
- localStorage for persistence
- Form validation using HTML5
