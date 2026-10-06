/**
 * Role-Based Personal Data Masking (Privacy by Design)
 * Ensures that staff members only see personal data strictly necessary for their function.
 */

class DataMaskingService {
  /**
   * Masks customer phone number for display.
   * e.g. "+213555123456" -> "+213 555 *** *56"
   */
  static maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const clean = phone.replace(/\s+/g, '');
    if (clean.length < 9) return clean;
    // Show prefix (+213), space, first 3 digits, space, ***, space, *, last 2 digits
    if (clean.startsWith('+213')) {
      const national = clean.substring(4);
      const op = national.substring(0, 3);
      const suffix = national.substring(national.length - 2);
      return `+213 ${op} *** *${suffix}`;
    }
    const prefix = clean.substring(0, 4);
    const suffix = clean.substring(clean.length - 2);
    return `${prefix} *** *${suffix}`;
  }

  /**
   * Scopes and masks customer record based on the requesting user's RBAC role.
   */
  static sanitizeCustomerForRole(customer, userRole) {
    if (!customer) return null;

    if (userRole === 'OWNER' || userRole === 'MANAGER') {
      return { ...customer }; // Full access
    }

    if (userRole === 'CASHIER') {
      return {
        ...customer,
        phone: this.maskPhone(customer.phone),
        address: '[محجوب للكاشير — يظهر فقط عند تأكيد التوصيل]',
        notes: customer.notes || ''
      };
    }

    if (userRole === 'STOCK_MANAGER' || userRole === 'ACCOUNTANT') {
      return {
        id: customer.id,
        name: customer.name,
        phone: this.maskPhone(customer.phone),
        credit_balance_centimes: customer.credit_balance_centimes
      };
    }

    // Default: strict masking
    return {
      id: customer.id,
      name: customer.name,
      phone: this.maskPhone(customer.phone)
    };
  }
}

module.exports = { DataMaskingService };
