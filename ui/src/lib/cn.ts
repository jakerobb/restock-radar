import { clsx, type ClassValue } from 'clsx'

/** Joins class names, skipping falsy ones. */
export const cn = (...inputs: ClassValue[]) => clsx(inputs)
