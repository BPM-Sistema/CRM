import './Switch.css';

interface SwitchProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  variant?: 'default' | 'danger';
}

export function Switch({ checked, onChange, disabled = false, variant = 'default' }: SwitchProps) {
  return (
    <label className={`switch ${variant === 'danger' ? 'switch--danger' : ''} ${disabled ? 'switch--disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={disabled ? undefined : onChange}
        disabled={disabled}
      />
      <div className="slider">
        <div className="circle">
          <svg className="checkmark" viewBox="0 0 12 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1.5 6 4.5 9 10.5 1" />
          </svg>
          <svg className="cross" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </div>
      </div>
    </label>
  );
}
