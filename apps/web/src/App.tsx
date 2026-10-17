import { useState } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { createWeaveRouter } from './router.js';

export function App() {
  const [router] = useState(createWeaveRouter);
  return <RouterProvider router={router} />;
}
