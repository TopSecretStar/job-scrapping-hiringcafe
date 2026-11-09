import './globals.css';

export const metadata = {
  title: 'Job Scrapper',
  description: 'Search and export job listings from hiringcafe.com',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
