# Patient Intake Form - Single Page Application

A frontend-only patient intake form with automatic local storage persistence.

## Features

- ✅ Complete patient intake form with multiple sections
- ✅ All form data persists to browser localStorage
- ✅ Automatic save on form submission and input changes
- ✅ Form data restored automatically on page reload
- ✅ No backend required - pure frontend
- ✅ Works with file:// protocol (direct browser opening)
- ✅ Responsive design for mobile and desktop
- ✅ Success feedback with auto-save status
- ✅ Form validation

## How to Use

### Option 1: Direct Browser Access
Simply open `index.html` directly in your browser:
```
1. Navigate to the index.html file
2. Right-click and select "Open with" → your browser
3. Or drag index.html into your browser window
```

### Option 2: Local Server (Optional)
If you prefer to serve via HTTP:
```bash
npx serve .
```
Then open http://localhost:3000

## Form Sections

1. **Personal Information**
   - First Name, Last Name
   - Date of Birth, Gender
   - Email, Phone Number

2. **Medical History**
   - Known Allergies (checkboxes)
   - Other Allergies (free text)
   - Current Medications

3. **Lifestyle Information**
   - Smoking Status (radio buttons)
   - Height & Weight

4. **Additional Information**
   - Additional Notes/Concerns

## Storage Details

- Data is stored in browser's localStorage with key: `patientIntakeFormData`
- Form data is automatically saved when:
  - User clicks "Save Form" button
  - User changes any form field (with 2-second debounce)
- Data persists across browser sessions and page reloads
- Clearing browser data/cache will reset the form

## Browser Compatibility

Works on all modern browsers with localStorage support:
- Chrome/Edge 4+
- Firefox 3.5+
- Safari 4+
- iOS Safari 3.2+
- Android Browser 2.1+

## Technical Stack

- Pure HTML5
- Vanilla JavaScript (ES6+)
- CSS3
- Browser localStorage API
