import React from 'react';
import useDarkMode from '../utils/useDarkMode';

const TONE_COLORS = {
    info: {
        light: { bg: '#e8f1ff', border: '#b6d4ff', text: '#0b3d91' },
        dark: { bg: '#0f1f3a', border: '#1f2f52', text: '#dbe7ff' }
    },
    warning: {
        light: { bg: '#fff7e6', border: '#ffd591', text: '#8a5200' },
        dark: { bg: '#0f172a', border: '#1f2a44', text: '#e5e7eb' }
    },
    danger: {
        light: { bg: '#fff6f6', border: '#ffd6d6', text: '#8b0000' },
        dark: { bg: '#3b0b0b', border: '#6b1414', text: '#ffd6d6' }
    }
};

export default function Notice({ title, children, tone = 'info', canClose = false, onClose, zIndex = 3000, style }) {
    const dark = useDarkMode();
    const palette = (TONE_COLORS[tone] || TONE_COLORS.info)[dark ? 'dark' : 'light'];

    const rootStyle = {
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        width: '55%',
        maxWidth: '960px',
        minWidth: '280px',
        zIndex,
        padding: '12px 16px',
        borderRadius: 8,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.text,
        textAlign: 'center',
        boxShadow: dark ? '0 2px 10px rgba(0,0,0,0.6)' : '0 2px 10px rgba(0,0,0,0.12)',
        ...style
    };

    const closeBtnStyle = {
        position: 'absolute',
        top: 6,
        right: 8,
        border: 'none',
        background: 'transparent',
        color: palette.text,
        fontSize: 16,
        cursor: 'pointer',
        lineHeight: '1'
    };

    return (
        <div style={rootStyle}>
            {canClose && (
                <button aria-label="关闭" style={closeBtnStyle} onClick={onClose}>×</button>
            )}
            {title && <div style={{ fontWeight: 700 }}>{title}</div>}
            {children && <div style={{ marginTop: title ? 6 : 0 }}>{children}</div>}
        </div>
    );
}
